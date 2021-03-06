var request = require('request');
var async = require('async');
var logger;
var lutil = require('lutil');
var url = require('url');
var crypto = require("crypto");
var path = require('path');

var dataStore, locker;

// internally we need these for happy fun stuff
exports.init = function(l, dStore, callback){
    dataStore = dStore;
    locker = l;
    logger = l.logger;
    callback();
}

// take an idr and turn it into a generic network-global key
// this could be network-specific transformation and need data
function idr2key(idr, data)
{
    delete idr.query; delete idr.search; // not account specific
    idr.pathname = '/'; // ids are generic across any context
    return url.parse(url.format(idr));
}

// internal util breakout
function idrHost(r, data)
{
    if(r.host === 'twitter')
    {
        r.hash = (r.pathname === 'related') ? data.id : data.id_str;
        r.protocol = 'tweet';
    }
    if(r.host === 'facebook')
    {
        r.hash = data.id;
        r.protocol = 'post';
    }
    if(r.host === 'foursquare')
    {
        r.hash = data.id;
        r.protocol = 'checkin';
    }
    if(r.host === 'instagram')
    {
        r.hash = data.id;
        r.protocol = 'photo';
    }
}
exports.idrHost = idrHost;

// useful to get key from raw data directly (like from a via, not from an event)
function getKey(network, data)
{
    var r = {slashes:true};
    r.host = network;
    r.pathname = '/';
    idrHost(r, data);
    return url.parse(url.format(r)); // make sure it's consistent
}

// normalize events a bit
exports.processEvent = function(event, callback)
{
    if(!callback) callback = function(err){if(err) logger.error(err);};
    var idr = url.parse(event.idr, true);
    if(!idr || !idr.protocol) return callback("don't understand this data");
    // handle links as a special case as we're using them for post-process-deduplication
    if(idr.protocol == 'link:') return processLink(event, callback);
    masterMaster(idr, event.data, callback);
}

// some data is incomplete, stupid but WTF do you do!
var profiles = {};
var mbQ = async.queue(masterBlaster, 1); // only process in series
function masterMaster(idr, data, callback)
{
    if(idr.protocol == 'checkin:' && idr.pathname.indexOf('checkin') != -1 && idr.query.id)
    { // foursquare checkins api for a person is the same json format but missing the .user, which we need to store the correct contact idr, so we have to fetch/cache that
        var svcId = idr.query.id;
        if(profiles[svcId])
        {
            data.user = profiles[svcId];
            return mbQ.push({idr:idr, data:data}, callback);
        }
        var lurl = locker.lockerBase + '/Me/'+svcId+'/getCurrent/profile';
        request.get({uri:lurl, json:true}, function(err, resp, arr){
            if(err || !arr || arr.length == 0)
            {
                logger.error("couldn't fetch profile for "+svcId+" so have to skip "+url.format(idr));
                return callback();
            }
            logger.debug("caching profile for "+svcId);
            data.user = profiles[svcId] = arr[0];
            return mbQ.push({idr:idr, data:data}, callback);
        });
        return;
    }
    mbQ.push({idr:idr, data:data}, callback);
}
exports.masterMaster = masterMaster;

// figure out what to do with any data
function masterBlaster(arg, callback)
{
    var idr = arg.idr;
    var data = arg.data;
    if(typeof data != 'object') return callback("missing or bad data");
//    logger.debug("MM\t"+url.format(idr));
    var ref = url.format(idr);
    var item = {keys:{}, refs:[], froms:{}, from:{}, responses:[], first:new Date().getTime(), last:new Date().getTime()};
    item.ref = ref;
    item.refs.push(ref);
    item.keys[url.format(idr2key(idr, data))] = item.ref;
    if(idr.protocol == 'tweet:'){
        if(data.user && data.text) itemTwitter(item, data);
        if(data.related) itemTwitterRelated(item, data.related);
    }
    if(idr.protocol == 'post:') itemFacebook(item, data);
    if(idr.protocol == 'checkin:') itemFoursquare(item, data);
    if(idr.host == 'instagram') itemInstagram(item, data);
    var dup;
    // we're only looking for the first match, if there's more, that's a very odd situation but could be handled here
    async.forEach(Object.keys(item.keys), function(key, cb) {
        dataStore.getItemByKey(key,function(err, doc){
            if(!err && doc) dup = doc;
            cb();
        });
    }, function (err) {
        if(!item.pri && !dup) return callback(); // some new items, like twitter related, are only for merging, shouldn't happen but if it does we may need to queue/stash or something
        if(dup) item = itemMerge(dup, item);
        dataStore.addItem(item, function(err, item){
            if(err) return callback(err);
            // all done processing, very useful to pull out some summary stats now!
            // feels inefficient to re-query and double-write here, but should be logically safe this way
            // TODO: can optimize and special case the first time!
            item.comments = item.ups = 0;
            dataStore.getResponses({item:item.id}, function(r){
                if(r.type == "comment") item.comments++;
                if(r.type == "up") item.ups++;
            }, function(){
                dataStore.addItem(item, callback); // finally call back!
            });
        });
    });
}

// save a reference
function itemRef(item, ref, callback)
{
    var refs = {};
    for(var i = 0; i < item.refs.length; i++) refs[item.refs[i]] = true;
    if(refs[ref]) return callback(undefined, item);
    refs[ref] = true;
    item.refs = Object.keys(refs);
    dataStore.addItem(item, callback);
}

// intelligently merge two items together and return
function itemMerge(older, newer)
{
//    logger.debug("MERGE\t"+JSON.stringify(older)+'\t'+JSON.stringify(newer));
    if(newer.pri > older.pri)
    { // replace top level summary stuff if newer is deemed better
        older.ref = newer.ref;
        older.from = newer.from;
        older.text = newer.text;
        if(newer.title) older.title = newer.title;
    }
    // update timestamps to extremes
    if(newer.last > older.last) older.last = newer.last;
    if(newer.first < older.first) older.first = newer.first;
    // update the two searchable objects
    for(var k in newer.keys) older.keys[k] = newer.keys[k];
    for(var k in newer.froms) older.froms[k] = newer.froms[k];
    // our array of references for this item, needs to be unique
    var refs = {};
    for(var i = 0; i < newer.refs.length; i++) refs[newer.refs[i]]=true;
    for(var i = 0; i < older.refs.length; i++) refs[older.refs[i]]=true;
    older.refs = Object.keys(refs);
    older.responses = newer.responses; // older doesn't have any since they're stored separately
    return older;
}

// merge existing with delete!
function itemMergeHard(a, b, cb)
{
    logger.debug("hard merge of "+a.ref+" to "+b.ref);
    var item = itemMerge(a, b);
    if(!item.responses) item.responses = [];
    // gather old responses
    dataStore.getResponses({item:b.id}, function(r){ item.responses.push(r); }, function(){
        // update existing item
        dataStore.addItem(item, function(err, item){
            if(err || !item) return cb(err);
            // now delete old fully!
            dataStore.delItem(b.id, cb);
        });
    });
}

// when a processed link event comes in, check to see if it's a long url that could help us de-dup
function processLink(event, callback)
{
    if(!event || !event.data || !event.data.encounters) return callback("no encounter");
    // process each encounter if there's multiple
    async.forEach(event.data.encounters, function(encounter, cb){
        // first, look up event via/orig key and see if we've processed it yet, if not (for some reason) ignore
        var key = url.format(getKey(encounter.network, encounter.via));
        dataStore.getItemByKey(key,function(err, item){
            if(err || !item) return cb(err);
            // we tag this item with a ref to the link, super handy for cross-collection mashups
            itemRef(item, event.idr, function(err, item){
                if(err || !item) return cb(err);
                var u = url.parse(encounter.link);
                // if foursquare checkin and from a tweet, generate foursquare key and look for it
                if(u.host == 'foursquare.com' && u.pathname.indexOf('/checkin/') > 0)
                {
                    var id = path.basename(u.pathname);
                    var k2 = 'checkin://foursquare/#'+id;
                    dataStore.getItemByKey(k2,function(err, item2){
                        if(err || !item2) return cb();
                        // found a dup!
                        itemMergeHard(item, item2, cb);
                    });
                }
                // instagram uses the same caption everywhere so link-based dedup isn't needed
            });
        });
    }, callback);
}
exports.processLink = processLink;

// give a bunch of sane defaults
function newResponse(item, type)
{
    return {
        type: type,
        ref: item.ref,
        from: {}
    }
}

// sometimes links can be used as raw keys
// using the hash value here because a ver of mongo will silently barf on some http based keys!!!
function keyUrl(item, link)
{
    var u = url.parse(link);
    if(!u || !u.host) return;
    // all instagram links across all services seem to be preserved
    if(u.host == 'instagr.am') item.keys["url:"+crypto.createHash('md5').update(link).digest('hex')] = item.ref;
}

// add key(s) based on a timestamp+-window (all in seconds)
function keyTime(item, at, window, prefix)
{
    var keys = {};
    var wlen = window.toString().length;
    var alen = at.toString().length;
    keys[at.toString().substr(0,alen-wlen)]=true;
    at += window;
    keys[at.toString().substr(0,alen-wlen)]=true;
    at -= (window*2);
    keys[at.toString().substr(0,alen-wlen)]=true;
    Object.keys(keys).forEach(function(key){ item.keys[prefix+key] = item.ref; });
}

// extract info from a tweet
function itemTwitter(item, tweet)
{
    item.pri = 1; // tweets are the lowest priority?

    // since RTs contain the original, add the response first then process the original!
    if(tweet.retweeted_status)
    {
        var resp = newResponse(item, "up");
        resp.from.id = "contact://twitter/#"+tweet.user.screen_name;
        resp.from.name = tweet.user.name;
        resp.from.icon = tweet.user.profile_image_url;
        item.responses.push(resp);
        tweet = tweet.retweeted_status;
        item.keys['tweet://twitter/#'+tweet.id_str] = item.ref; // tag with the original too
    }

    if(tweet.created_at) item.first = item.last = new Date(tweet.created_at).getTime();
    if(tweet.text) item.text = tweet.text;
    if(tweet.user)
    {
        item.from.id = "contact://twitter/#"+tweet.user.screen_name;
        item.from.name = tweet.user.name;
        item.from.icon = tweet.user.profile_image_url;
        item.froms[item.from.id] = item.ref;
    }
    // add a text based key
    if(item.text)
    {
        var hash = crypto.createHash('md5');
        hash.update(item.text.substr(0,130)); // ignore trimming variations
        item.keys['text:'+hash.digest('hex')] = item.ref;
        hash = crypto.createHash('md5');
        hash.update(item.text.replace(/ http\:\/\/\S+$/,"")); // cut off appendege links that some apps add (like instagram)
        item.keys['text:'+hash.digest('hex')] = item.ref;
    }
    // check all links
    if(tweet.entities && tweet.entities.urls) tweet.entities.urls.forEach(function(link){if(link.expanded_url) keyUrl(item, link.expanded_url);});

    // if this is also a reply
    if(tweet.in_reply_to_status_id_str)
    {
        item.pri = 0; // demoted
        item.keys['tweet://twitter/#'+tweet.in_reply_to_status_id_str] = item.ref; // hopefully this merges with original if it exists
        var resp = newResponse(item, "comment");
        // duplicate stuff into response too
        resp.text = item.text;
        resp.at = item.first;
        resp.from.id = item.from.id;
        resp.from.name = item.from.name;
        resp.from.icon = item.from.icon;
        item.responses.push(resp);
    }
}

// extract info from a facebook post
function itemFacebook(item, post)
{
    item.pri = 2; // facebook allows more text, always better?
    item.first = post.created_time * 1000;
    item.last = post.updated_time * 1000;
    if(post.from)
    {
        item.from.id = 'contact://facebook/#'+post.from.id;
        item.from.name = post.from.name;
        item.from.icon = 'https://graph.facebook.com/' + post.from.id + '/picture';
        item.froms[item.from.id] = item.ref;
    }
    if(post.name) item.title = post.name;
    if(post.message) item.text = post.message;
    if(!item.text && post.description) item.text = post.description;
    if(!item.text && post.caption) item.text = post.caption;
    if(!item.text && post.story) item.text = post.story;
    // should we only add a text key if we can detect it's a tweet? we're de-duping any fb post essentially
    if(item.text)
    {
        var hash = crypto.createHash('md5');
        hash.update(item.text.substr(0,130)); // ignore trimming variations
        item.keys['text:'+hash.digest('hex')] = item.ref;
    }
    if(post.link) keyUrl(item, post.link);
    if(!item.text && post.type == "photo") item.text = "New Photo";

    // process responses!
    if(post.comments && post.comments.data)
    {
        post.comments.data.forEach(function(comment){
            if(!comment.from) return; // anonymous comments skipped
            var resp = newResponse(item, "comment");
            resp.at = comment.created_time * 1000;
            resp.text = comment.message;
            resp.from.id = 'contact://facebook/#'+comment.from.id;
            resp.from.name = comment.from.name;
            resp.from.icon = 'https://graph.facebook.com/' + comment.from.id + '/picture';
            item.responses.push(resp);
        });
    }
    if(post.likes && post.likes.data)
    {
        post.likes.data.forEach(function(like){
            var resp = newResponse(item, "up");
            resp.from.id = 'contact://facebook/#'+like.id;
            resp.from.name = like.name;
            resp.from.icon = 'https://graph.facebook.com/' + like.id + '/picture';
            item.responses.push(resp);
        });
    }
}

// extract info from a foursquare checkin
function itemFoursquare(item, checkin)
{
    item.pri = 3; // ideally a checkin should source here as the best
    item.first = item.last = checkin.createdAt * 1000;
    if(checkin.venue) item.text = "Checked in at " + checkin.venue.name;
    if(checkin.shout)
    {
        item.text = checkin.shout;
        var hash = crypto.createHash('md5');
        hash.update(item.text.substr(0,130)); // ignore trimming variations
        item.keys['text:'+hash.digest('hex')] = item.ref;
    }
    // foursquare preserves no other metadata than the shout in a cross-post, so we fall back to timestamp window :(
    if(checkin.photos && checkin.photos.items) checkin.photos.items.forEach(function(photo){
        if(!photo.source || photo.source.name != "Instagram") return;
        keyTime(item, photo.createdAt, 5, "igts:");
    });
    var profile = checkin.user;
    item.from.id = 'contact://foursquare/#'+profile.id;
    item.from.name = profile.firstName + " " + profile.lastName;
    item.from.icon = profile.photo;
    item.froms[item.from.id] = item.ref;
    if(checkin.comments && checkin.comments.items)
    {
        checkin.comments.items.forEach(function(comment){
            // TODO: can't find examples of this!
        });
    }

}

// process twitter's post-tweet related data
function itemTwitterRelated(item, relateds)
{
    relateds.forEach(function(related){
        related.results.forEach(function(result){
            // ReTweet type by default is only the user object
            var resp = newResponse(item, "up");
            var user = result;
            if(related.resultType == "Tweet") {
                resp.type = "comment";
                resp.text = result.value.text;
                user = result.value.user;
                resp.at = new Date(result.value.created_at).getTime();
            }
            resp.from.id = "contact://twitter/#"+user.screen_name;
            resp.from.name = user.name;
            resp.from.icon = user.profile_image_url;
            item.responses.push(resp);
        });
    });
}

// extract info from an instagram pic
function itemInstagram(item, pic)
{
    item.pri = 4; // the source
    item.first = item.last = pic.created_time * 1000;
    if(pic.caption && pic.caption.text.length > 0) item.text = pic.caption.text;
    if(pic.user)
    {
        item.from.id = 'contact://instagram/#'+pic.user.id;
        item.from.name = pic.user.full_name;
        item.from.icon = pic.user.profile_picture;
        item.froms[item.from.id] = item.ref;
    }

    if(item.text)
    {
        var hash = crypto.createHash('md5');
        hash.update(item.text.substr(0,130)); // ignore trimming variations
        item.keys['text:'+hash.digest('hex')] = item.ref;
    }else{
        item.text = "New Picture";
        // if there's no caption, we have to key the timestamp to catch foursquare cross-posting since it has no other metadata :(
        keyTime(item, pic.created_time, 5, "igts:");
    }

    if(pic.link) keyUrl(item, pic.link);

    // process responses!
    if(pic.comments && pic.comments.data)
    {
        pic.comments.data.forEach(function(comment){
            var resp = newResponse(item, "comment");
            resp.at = comment.created_time * 1000;
            resp.text = comment.text;
            resp.from.id = 'contact://instagram/#'+comment.from.id;
            resp.from.name = comment.from.full_name;
            resp.from.icon = comment.from.profile_picture;
            item.responses.push(resp);
        });
    }
    if(pic.likes && pic.likes.data)
    {
        pic.likes.data.forEach(function(like){
            var resp = newResponse(item, "up");
            resp.from.id = 'contact://instagram/#'+like.id;
            resp.from.name = like.full_name;
            resp.from.icon = like.profile_picture;
            item.responses.push(resp);
        });
    }
}

