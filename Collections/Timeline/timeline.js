/*
*
* Copyright (C) 2011, The Locker Project
* All rights reserved.
*
* Please see the LICENSE file for more information.
*
*/

// merge newsfeed style data and any gather any responses

var fs = require('fs'),
    url = require('url'),
    request = require('request'),
    locker = require('locker.js'),
    lconfig = require('lconfig');
var logger;
var async = require("async");
var url = require("url");

var dataIn = require('./dataIn'); // for processing incoming twitter/facebook/etc data types
var dataStore = require("./dataStore"); // storage/retreival of raw items and responses
var sync = require('./sync'); // for manual updating/resyncing of data from synclets

var lockerInfo;
var express = require('express'),
    connect = require('connect');
var app = express.createServer(connect.bodyParser());

app.set('views', __dirname);

app.get('/', function(req, res) {
    var fields = {};
    if (req.query.fields) {
        try { fields = JSON.parse(req.query.fields); } catch(E) {}
    }
    dataStore.getAll(fields, function(err, cursor) {
        if(!req.query["all"]) cursor.limit(20); // default 20 unless all is set
        if(req.query["limit"]) cursor.limit(parseInt(req.query["limit"]));
        if(req.query["offset"]) cursor.skip(parseInt(req.query["offset"]));
        var sorter = {"first":-1};
        if(req.query["sort"]) {
            sorter = {};
            if(req.query["order"]) {
                sorter[req.query["sort"]] = +req.query["order"];
            } else {
                sorter[req.query["sort"]]= 1;
            }
        }
        var ndx = {};
        cursor.sort(sorter).toArray(function(err, items) {
            if(req.query["all"] || !req.query.full) return res.send(items); // default not include responses, forced if all
            items.forEach(function(item){ ndx[item.id] = item; item.responses = []; }); // build index
            var arg = {"item":{$in: Object.keys(ndx)}};
            arg.fields = fields;
            dataStore.getResponses(arg, function(response) {
                ndx[response.item].responses.push(response);
            }, function() {
                res.send(items);
            });
        });
    });
});

app.get('/state', function(req, res) {
    dataStore.getTotalItems(function(err, countInfo) {
        if(err) return res.send(err, 500);
        var updated = new Date().getTime();
        var js;
        try {
            js = JSON.parse(fs.readFileSync('state.json'));
        } catch(E) {}
        if(!js) js = {ready:0};
        js.count = countInfo;
        res.send(js);
    });
});

// expose way to get the list of responses from an item id
app.get('/responses/:id', function(req, res) {
    var results = [];
    dataStore.getResponses({item:req.param('id')}, function(item){results.push(item);},function(err){
        if(err) return res.send(err,500);
        res.send(results);
    });
});

app.get('/id/:id', function(req, res) {
    dataStore.getItem(req.param('id'), function(err, doc) { return (err != null || !doc) ? res.send(err, 500) : res.send(doc); });
});

// this would only be useful if something changes or removes state.json
app.get('/sync', function(req, res) {
    res.send(true);
    sync.sync(); // happens async
});

// sync.init() optionally listens for work events, funnel back
app.post('/work', function(req, res) {
    if (!req.body.idr || !req.body.data){
        logger.error('bad work data: ',JSON.stringify(req.body));
        return res.send('bad data', 500);
    }
    res.send('ok');
    sync.work(req.body.data.work);
});

app.get('/ref', function(req, res) {
    var idr = url.parse(req.query.id);
    if(!idr || !idr.hash) return res.send("missing or invalid id",500);
    var lurl = locker.lockerBase + '/Me/' + idr.host + idr.pathname + '/id/' + idr.hash.substr(1);
    request.get({url:lurl, json:true}, function(err, res2, body){
        if(err || !body) return res.send(err, 500);
        res.send(body);
    });
});

app.post('/events', function(req, res) {
    if (!req.body.idr || !req.body.data){
        logger.error('5 HUNDO bad data:',JSON.stringify(req.body));
        res.writeHead(500);
        res.end('bad data');
        return;
    }
    res.send('ok');
    // handle asyncadilly
    dataIn.processEvent(req.body, function(err){
        if(err) logger.error(err);
    });
});

function genericApi(name,f)
{
    app.get(name,function(req,res){
        var results = [];
        f(req.query,function(item){results.push(item);},function(err){
            if(err) return res.send(err,500);
            res.send(results);
        });
    });
}

genericApi('/getItems', dataStore.getItems);
genericApi('/getResponses', dataStore.getResponses);
genericApi('/getSince', dataStore.getSince);

// Process the startup JSON object
process.stdin.resume();
process.stdin.on('data', function(data) {
    lockerInfo = JSON.parse(data);
    locker.initClient(lockerInfo);
    locker.lockerBase = lockerInfo.lockerUrl;
    if (!lockerInfo || !lockerInfo['workingDirectory']) {
        process.stderr.write('Was not passed valid startup information.'+data+'\n');
        process.exit(1);
    }
    process.chdir(lockerInfo.workingDirectory);
    lconfig.load('../../Config/config.json');
    locker.logger = logger = require('logger');

    locker.connectToMongo(function(mongo) {
        // initialize all our libs
        dataStore.init(mongo.collections.item,mongo.collections.response, locker, function(err){
            if(err) logger.error("datastore init failed: ",err);
            dataIn.init(locker, dataStore, function(){
                sync.init(locker, dataStore, dataIn, function(){
                    app.listen(lockerInfo.port, 'localhost', function() {
                        process.stdout.write(data);
                    });
                });
            });
        });
    });
});
