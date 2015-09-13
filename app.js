"use strict";
/*jslint node: true, nomen: true*/
/*ki1r0y app. This configures all the pieces. Sections are Modules, Application Setup, Routes, and Initialization.*/
/*Copyright (c) 2013-2015 Howard Stearns. MIT License*/

/// MODULES:

var path = require('path');
var http = require('http');
var express = require('express');
var session = require('express-session');
var favicon = require('serve-favicon');
var morgan = require('morgan');
var bodyParser = require('body-parser');
var multer  = require('multer');
var passport = require('passport');
var BasicStrategy = require('passport-http').BasicStrategy;
var FacebookStrategy = require('passport-facebook').Strategy;
var request = require('request');
var socketio = require('socket.io');
var _ = require('underscore');

var pseudo = require('./pseudo-request');
var gc = require('./realtime-garbage-collector');
var db = require('./routes/db'); // FIXME try to remove
var nouns = require('./routes/nouns');
var store = require('ki1r0y.fs-store');
var search = require('ki1r0y.simple-search');
var chat = require('./routes/chat');
var site = require('./routes/site');

function secret(key) {   // Grab a secret from the shell environment, or report that it wasn't set.
    if (process.env[key]) { return process.env[key]; }
    throw new Error("Please set environment variable: " + key);
}
// Answer a set of headers (side-effecting optionalHeaders if supplied), such that the morgan logger will indicate userIdentifier as the requesting user.
function logUser(userIdentifier, optionalHeaders) { // BTW, isDev logging does not show user. Production logging does.
    var headers = optionalHeaders || {};
    headers.authorization = "Basic " + new Buffer(userIdentifier + ':').toString('base64');
    return headers;
}
function dualCallback(res, next) {    // Create a nodejs callback(err, val) that also closes out an expressjs route handler.
    return function (err, data) {
        if (err) {
            next(err);                // We could instead do: res.writeHead(500); res.end(error.message || error);
        } else if (data) {
            res.send(data);           // express will set content-type header to application/json.
        } else {
            res.send({status: "ok"}); // answer text that as parseable as JSON, to make things easier if we have other responses
        }
    };
}

/// APPLICATION SETUP:

var app = express();
var isDev = app.get('env') === 'development';
// app.locals are directly available to templates:
app.locals.pretty = isDev; // Tell template system whether to format HTML readably.
app.locals.title = 'Ki1r0y';
app.locals.fbAppId = '234339356748266';
process.title = app.locals.title.toLowerCase();          // so we can kill the server with shell (pkill ki1r0y)
app.locals.oneYearSeconds = 60 * 60 * 24 * 365;          // W3C recommends not aging more than a year. 
app.locals.oneYearMs = app.locals.oneYearSeconds * 1000; // Express/connect time is in milliseconds (as for node generally).
// app.set'tings are available to middleware:
var dbdir = path.resolve(__dirname, '../db');
app.set('dbdir', dbdir);      // Must be on same system for efficient file uploads and static gets.
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'jade');
var logger = morgan((isDev && process.stdin.isTTY) ? 'dev' : 'combined'); // Alas, morgan isn't smart enough to turn off colors when not a tty.
// Configure the implementations of how we persist/serve data:
var paths = {
    //function isPlace(idtag) { return idtag.length !== 40; } // predicate true if idtag is for a place (a mutable, versioned thing)
    isPlace: function isPlace(idtag) { return (idtag.length === 37) || (idtag.length === 28) || (idtag.length === 41); }, // FIXME: transition hack: 37=MS-GUID, 27=sha1/base64-=, 40=sha1/hex
    dbdir: dbdir,
    // These all answer falsey if no arg.
    dbFile: function dbFile(key, base, ext) { return key ? path.resolve(dbdir, base, key) + (ext || '') : ''; }, // internal helper
    newspaceDir: function newspaceDir(oldspace) { return oldspace + '2'; },
    newspaceFile: function newspaceFile(filePath) { return paths.dbFile(path.basename(filePath), paths.newspaceDir(path.dirname(filePath))); },
    // FIXME: Should just be .json, but handling old style idtags for transition
    compatableExtension: function compatableExtension(idtag) { return ((40 <= idtag.length) && (idtag.length <= 41)) ? '.json' : ''; },
    // answer pathname for place or thing
    idFile: function idFile(idtag) { return paths.dbFile(idtag, paths.isPlace(idtag) ? 'mutable/place' : 'immutable/thing', paths.compatableExtension(idtag)); },
    // answer pathname for our user data record
    userFile: function userFile(idtag) { return paths.dbFile(idtag, 'mutable/people', paths.compatableExtension(idtag)); },
    // thumbnail for idvtag
    thumbFile: function thumbFile(idvtag) { var base = paths.dbFile(idvtag, 'immutable/thumb'); return base ? base + '.png' : ''; },
    // filename must have extension
    mediaFile: function mediaFile(filename) { return paths.dbFile(filename, 'immutable/media'); },
    // answer pathname for the list of scenes that reference idtag
    refsFile: function refsFile(idtag) { return paths.dbFile(idtag, 'mutable/refs'); },
    // FIXME: needs subdirectories. // answer pathname for the list of idtags that cite the given word
    citationsFile: function citationsFile(word) { return paths.dbFile(word, 'mutable/citation'); }
};
function mutable(collection) { return express.static(path.join(app.get('dbdir'), 'mutable', collection)); }
function immutable(collection) { return express.static(path.join(app.get('dbdir'), 'immutable', collection), {maxAge: app.locals.oneYearMs}); }
nouns.getThing = immutable('thing'); // When using the file system as we are, these can be more efficient than the defaults.
nouns.getThumb = immutable('thumb');  // FIXME: define default defs in nouns  and make sure they work!
nouns.getMedia = immutable('media');
nouns.getPlace = mutable('place');
pseudo.configure(logger);
db.configure(paths);
nouns.configure({handleRoute: dualCallback, paths: paths});

/// ROUTES:

// Puns: We could make all get/post/delete be computed with its own function, specific to the particular route.  But if
// we make the routes look like they correspond directly to static files on a file system, it gives us the opportunity
// to actually implement them that way if we want to. In fact, 'get' is implemented by just grabbing the named file, and
// 'delete' is implemented by a generic middleware that just deletes the named file. (post is separate) In both 'get'
// and 'delete, respective the middlewares convert, e.g., /thing/123.json to ../db/immutable/thing/123.json. We could
// have gone even further and had them also add the .json file extension, so that browsers would not have to include
// those four extra characters in the url. Instead, we chose to make the extension an explicit part of the url (rather
// than implied), as this serves as documentation, and helps various options for middleware figure out what they need to
// do without having to right special machinery.  For example, if the file extension was implicit, we could still use
// express.static, and give it a special function to set the Content-Type header to application/json. By making the
// extension explicit in the url, we don't need to. This gives us more flexibility to, e.g., replace express.static with
// something like Amazon S3 (slow!), which might not have the hook we need to do the transformation. For media, it makes
// it easier to inspect the uploaded files. In other words, we're trying to be "normal" in our conventions.

app.use(favicon(path.join(__dirname, 'public/images/favicon.ico')));
app.use(logger); // After favicon so that it isn't logged.
app.get('/', function (req, res) { _.noop(req); res.redirect('/site/hot.html'); });
app.use('/site/:id.html', site.standard);
app.use('/browser', express.static(path.join(__dirname, 'browser'))); // Not cached yet. Should be cached in production, with versioned filenames.
app.use(express.static(path.join(__dirname, 'public')));

// Uniform length names makes it easy to visually grok logs.
// Singular names are internal resource transfers.
app.use('/thing', nouns.getThing);
app.use('/thumb', nouns.getThumb);
app.use('/place', nouns.getPlace);

// Peculiar toplevel 'files'.
// See http://developers.facebook.com/docs/reference/javascript
app.get('/channel.html', function (req, res) {
    _.noop(req);
    res.header({Pragma: 'public',
                'Cache-Control': 'max-age="' + app.locals.oneYearSeconds + '"',
                Expires: new Date(Date.now() + app.locals.oneYearMs).toUTCString()});
    res.send('<script src="//connect.facebook.net/en_US/all.js"></script>');
});

// Plural names are toplevel user requests.
app.get('/people/:userIdtag', nouns.getUserPage);
app.get('/places/:sceneIdtag', nouns.getItemPage);
app.get('/things/:objectIdtag', nouns.getItemPage);

// Handy for testing:
app.get('/q/scenesContaining/:objectIdtag', nouns.getPlacesContaining);
app.get('/q/hasWord/:text', nouns.getItemIdtagsWithText);
app.get('/q/search/:text', nouns.getItemsWithText);

// compatability with old ids. FIXME: authenticate (e.g., unity form.headers["Cookie"] = "connect.sid=....; facebook token...", but see http://docs.unity3d.com/ScriptReference/WWWForm-headers.html re pass by value)
// Alas, Unity WWW class cannot do 'PUT'. FIXME: app.use(methodOverride()) and have client set header X-HTTP-Method-Override.
var fakeJson = [
    bodyParser.urlencoded({ extended: false }),
    function treatBodyAsJson(req, res, next) {
        _.noop(res);
        req.body.data = JSON.parse(req.body.data);
        next();
    }];
app.post('/place/:id', fakeJson, nouns.putPlace);
app.post('/thing/:id', fakeJson, nouns.putThing);
app.post('/refs/:id', fakeJson, nouns.postRefs); // Old name for pRefs.
app.use(bodyParser.json()); // Our put/post data 
var upload = multer({dest: path.resolve(__dirname, '../uploads/')});
var singleFileUpload = upload.single('fileUpload'); // route converts 'fileUpload' form field to req.file (an object with 'path' property), and adds any text fields to req.body
app.post('/thumb/:id', singleFileUpload, nouns.putThumb);
app.post('/media/:id', singleFileUpload, nouns.putMedia);

// These aren't needed for any of the above.
// FIXME: The default server-side cookie implementation leaks memory.
app.use(session({ // Create/parse session cookies to make authorization more efficient.
    secret: secret('COOKIE_SIGNER'),
    resave: false,
    saveUninitialized: true,
}));
// When passport first authenticates a user, this is called to pickle the user. req.session.passport.user will get the second value passed to done.
passport.serializeUser(function (user, done) { done(null, JSON.stringify(user)); });
// Converts req.session.passport.user to user object, which passport ...FIXME
passport.deserializeUser(function (pickled, done) { done(null, JSON.parse(pickled)); });

var testUserAuth = secret('TEST_USER_AUTH');
passport.use(new BasicStrategy(function (username, password, done) {
    // When passport does not find a serialized user in the session cookie, it attempts to obtain the credentials based on the strategry.
    // If there are credentials, it invokes this callback to produce an authenticated user from the given credentials.
    setImmediate(function () {
        // Note that improper credentials produces a falsey user, not an error (which would indicate a machinery failure).
        done(null, ((username === 'JS Kilroy') && (password === testUserAuth)) &&
             {idtag: '100007663687854', username: username});
    });
}));
/*passport.use(new FacebookStrategy({
    clientID: app.locals.fbAppId,
    clientSecret: secret('FB_CLIENT_SECRET')
}, function (accessToken, refreshToken, profile, done) {
    setImmediate(function () {
        profile.accessToken = accessToken;
        profile.refreshToken = refreshToken;
        done(null, profile);
    });
}));
*/
passport.use(new FacebookStrategy({
    clientID: app.locals.fbAppId,
    clientSecret: secret('FB_CLIENT_SECRET'),
    //enableProof: true, //FIXME
    passReqToCallback: true // Causes req to be the first agument to the following function.
}, function (req, accessToken, refreshToken, profile, done) {
    _.noop(refreshToken);
    //console.log('fb authenticate', profile && profile.displayName, req.params.friend, req.url);
    request.get({ // Ask facebook if this authenticated user is a friend of the requested user.
        // We do this at the server so that false clients can't spoof affirmative responses.
        // Asking for one specific friend is much easier than making multiple paged requests for all friends.
        url: 'https://graph.facebook.com/v2.4/me/friends/' + req.params.friend + '?access_token=' + accessToken,
        json: true
    }, function (err, response, body) {
        if (!err && (response.statusCode !== 200)) { err = new Error(response.statusMessage); }
        if (err || !body.data.length) {
            profile = null;
        } else {
            profile.authorizedFriend = req.params.friend; // stamp this user session as being for this friend.
            // When we need to check a new friend, we currently repeat the WHOLE authentication/autorization process,
            // including the round trip to authenticate the user. IWBNI we optimized this by skipping the auth if possible,
            // and do JUST the friend-check authorization.
            profile.idtag = profile.id; // adapt from passport name
            profile.username = profile.displayName; // ditto
            logUser(profile.idtag, req.headers); // So that this request can be loged with correct user idtag.
        }
        return done(err,  profile);
    });
}));
// This one is is used in the route to determine whether the given authenticated user is authorized for the next step in the route.
function authorize(req, res, next) {
    var skipLogin = 'skipLogin';
    function verify(err, user, info) { // Ultimately, our job is to call next(falseyOr401orOtherError):
        if (err) { return next(err); }
        if (user) {
            logUser(user.idtag, req.headers);
            if (info === skipLogin) { return next(); }
            pseudo.info({url: '/loginScope?username=' + user.username, headers: req.headers});
            return req.login(user, next);
        }
        err = new Error((info && info.message) || ('Unauthorized: ' + info)); // The various strategies aren't consistent in their use of info.
        err.status = 401;
        next(err);
    }
    if (req.isAuthenticated()) {
        return setImmediate(function () { verify(null, req.user, skipLogin); });
    }
    // authenticate answers a middleware(req, res, next) that uses the specified strategy to authenticate a user, presented in the callback.
    passport.authenticate('basic', verify)(req, res, next);
}
app.use(passport.initialize());
app.use(passport.session());
// Clears passport session. Browser code can invoke this (e.g., as xmlhttp), but this can't log the user out of FB in the browser.
app.get('/logout', function (req, res) {
    req.logout();
    res.redirect('/');
});
function echoUser(req, res) { res.send(req.user); } // For testing, echo the pickled authorized user object, if any.
app.get('/testAuth', authorize, echoUser);
// Facebook auth development: answers data if logged in FB user is a friend of specified id
app.get('/fbtest/:friend', function (req, res, next) {
    if (req.isAuthenticated() && (req.user.authorizedFriend === req.params.friend)) {
        logUser(req.user.idtag, req.headers);
        return setImmediate(next);
    }
    // calbackURL is "documented" at https://github.com/jaredhanson/passport-facebook/issues/2
    passport.authenticate('facebook', {callbackURL: '/fbtest/' + req.params.friend})(req, res, next);
}, echoUser);

// FIXME: Authentication isn't enough. Need to figure out how to authorize by seeing that user if friend of author of the current space. (How to tell current space?)
app.use('/media', /*FIXME authorize,*/ nouns.getMedia);
//      '/fbusr (person) download isn't needed, and it would create issues for access control and when there are large numbers of user-created scenes.
app.get('/xport/:objectIdtag', nouns.getXport); // A dynamically generated .zip of the media associated with a (composite) thing.

// Corresponds to a get with the same url. (E.g., therefore 'put', not 'post')
app.put('/place/:id.json', authorize, nouns.putPlace); //FIXME: auth if data.author is req.user.idtag
app.put('/thing/:id.json', authorize, nouns.putThing); //FIXME: auth if data.author is req.user.idtag
app.put('/thumb/:id.png', authorize, singleFileUpload, nouns.putThumb); //FIXME: auth if thingIdtag.author is req.user.idtag. Is there a race condition?
app.put('/media/:id', authorize, singleFileUpload, nouns.putMedia); // Note that the file ending is part of the id. // FIXME: No user idtag. Need to be given first by thing? Race condition?
app.delete('/:collection/:id.:ext', authorize, nouns.delete); // For testing.  //FIXME: auth if xxxIdtag.author is req.userIdtag
// No corresponding get (hence post, not put)
app.post('/pRefs/:id.json', authorize, nouns.postRefs); // FIXME: what auth?
app.post('/fbusr/:id.json', /*FIXME authorize, */nouns.postPerson); //FIXME: auth if :id is req.user.idtag

// Error Handling:
// If we get this far, nothing has picked up the request. Give a 404 error to the error handler.
app.use(function (req, res, next) {
    var err = new Error('Not Found');
    _.noop(req, res);
    err.status = 404;
    next(err);
});

// error handlers are distinguished by their arity.
app.use(function (err, req, res, next) {
    _.noop(req, next);
    if (isDev && !_.contains([401, 404], err.status)) { console.error(err.stack); }
    if (err.code === 'ENOENT') { err.status = 404; }
    res.status(err.status || 500);
    res.render('error', {
        message: err.message,
        error: err
    });
});

/// INITIALIZATION:

gc.pingPong(app.get('dbdir'), 2000, function (e) {
    if (e) { throw e; }
    var server = http.createServer(app);
    chat.initialize(socketio(server), {info: pseudo.info, logUser: logUser, textSearch: nouns.itemsWithText});
    server.listen(3000);
});
