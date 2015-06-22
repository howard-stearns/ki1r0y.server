"use strict";
/*jslint node:true, nomen: true */

var express = require('express');
var path = require('path');
var favicon = require('serve-favicon');
var morgan = require('morgan');
var cookieParser = require('cookie-parser');
var bodyParser = require('body-parser');
var multer  = require('multer');
var _ = require('underscore');

var pseudo = require('./pseudo-request');

var socketio = require('socket.io');
var chat = require('./routes/chat');

var routes = require('./routes/index');
var site = require('./routes/site');

// FIXME: what belongs in app.locals vs app.set/get
// FIXME: maybe just add properties to app?
// FIXME: specifically, a function for collection resolution (relative to dbdir)

var app = express();
var isDev = app.get('env') === 'development';
// app.locals are directly available to templates.
app.locals.pretty = isDev;
app.locals.title = 'Ki1r0y';
app.locals.fbAppId = '234339356748266';
process.title = app.locals.title.toLowerCase(); // so we can kill the server with shell (pkill kilroy)
// W3C recommends not aging more than a year. Express/connect expresses time in milliseconds (as for node generally).
app.locals.oneYearSeconds = 60 * 60 * 24 * 365;
app.locals.oneYearMs = app.locals.oneYearSeconds * 1000;

// app.get/set operates on an extensible group of application settings.
// For efficient uploads, we fs.rename files from uploadDir to db, but that won't work if they are on different file systems.
app.set('dbdir', path.resolve(__dirname, '../db'));
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'jade');
// Alas, morgan isn't smart enough to turn off colors when not a tty.
var logger = morgan((isDev && process.stdin.isTTY) ? 'dev' : 'combined');
pseudo.configure(logger);
function mutable(collection) { return express.static(path.join(app.get('dbdir'), 'mutable', collection)); }
function immutable(collection) { return express.static(path.join(app.get('dbdir'), 'immutable', collection), {maxAge: app.locals.oneYearMs}); }

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
app.use('/thing', immutable('thing'));
app.use('/thumb', immutable('thumb'));
app.use('/place', mutable('place'));

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
app.get('/people/:userIdtag', routes.user);
app.get('/places/:sceneIdtag', routes.scene);
app.get('/things/:objectIdtag', routes.scene);

// Handy for testing:
app.get('/q/scenesContaining/:objectIdtag', routes.refs);
app.get('/q/hasWord/:text', routes.citations);
app.get('/q/search/:text', routes.search);

// These aren't needed for any of the above.
app.use(bodyParser.json());
app.use(multer({dest: path.resolve(__dirname, '../uploads/'), putSingleFilesInArray: true})); // Media file uploads
app.use(cookieParser());

app.use('/media', immutable('media'));
//      '/fbusr (person) download isn't needed, and it would create issues for access control and when there are large numbers of user-created scenes.
app.get('/xport/:objectIdtag', routes.exportMedia); // A dynamically generated .zip of the media associated with a (composite) thing.

// Correspond to a get with the same url. (E.g., therefore 'put', not 'post')
app.put('/place/:id.json', routes.uploadPlace);
app.put('/thing/:id.json', routes.uploadObject);
app.put('/thumb/:id.png', routes.uploadThumbnail);
app.put('/media/:id', routes.uploadMedia); // Note that the file ending is part of the id.
app.delete('/:collection/:id.:ext', routes.delete); // For testing

app.post('/fbusr/:id.json', routes.updateUser);
app.post('/pRefs/:id.json', routes.uploadRefs);
// compatability with old ids
// Alas, Unity WWW class cannot do 'PUT'.
var fakeJson = [
    bodyParser.urlencoded({ extended: false }),
    function treatBodyAsJson(req, res, next) {
        _.noop(res);
        req.body.data = JSON.parse(req.body.data);
        next();
    }];
app.post('/place/:id', fakeJson, routes.uploadPlace);
app.post('/thing/:id', fakeJson, routes.uploadObject);
app.post('/refs/:id', fakeJson, routes.uploadRefs); // Old name for pRefs.
app.post('/thumb/:id', routes.uploadThumbnail);
app.post('/media/:id', routes.uploadMedia);

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
    if (isDev && (err.status !== 404)) { console.error(err.stack); }
    if (err.code === 'ENOENT') { err.status = 404; }
    res.status(err.status || 500);
    res.render('error', {
        message: err.message,
        error: err
    });
});

require('./realtime-garbage-collector').pingPong(app.get('dbdir'), 2000);
var server = require('http').createServer(app);
chat.setup(socketio(server));
server.listen(3000);
