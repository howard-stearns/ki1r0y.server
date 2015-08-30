"use strict";
/*jslint node: true, nomen: true, vars: true */
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var assert = require('assert');
var mocha = require('mocha'), describe = mocha.describe, before = mocha.before, after = mocha.after, it = mocha.it;
var shell = require('child_process');
var async = require('async');
var request = require('request');
var cheerio = require('cheerio');
var _ = require('underscore');
var _s = require('underscore.string');
var testUserPass = process.env.TEST_USER_AUTH;
if (!testUserPass) { throw new Error('Please specify TEST_USER_AUTH'); }
var credentials = {user: 'JS Kilroy', pass: testUserPass};

describe('server', function () {
    var port = 3000, base = 'http://localhost:' + port, ourServer; // the server we should talk to
    var stats = {};
    function serverIsRunning() { // true if the server is listening
        return shell.spawnSync('curl', ['http://localhost:' + port]).status === 0;
    }
    function waitForChange(wantsRunning, cb) { // cb() only when serverIsRunning matches wantsRunning
        var loop = wantsRunning ? async.doUntil : async.doWhilst;
        loop(function (icb) {
            setTimeout(icb, 1000);
        }, serverIsRunning, cb);
    }

    // assertions
    function assertOk(res) { assert.deepEqual(res, {status: 'ok'}); } // Normal uninformative-but-ok json response
    function assertMime(res, optionalMime) { // Check mime type. Fancy 'application/json' if optionalMime ommitted.
        var contentType = res.headers['content-type'];
        if (optionalMime) { return assert.equal(contentType, optionalMime); }
        // The content-type standard is a bit vague. Charset is an optional addition to content-type, and json
        // spec says that application/json uses utf-8. So, do we have to specify charset?
        // In fact, express-static sets 'Content-Type: application/json' for json files (no charset),
        // while express Response.send sets 'Content-Type: application/json; charset=utf-8'.
        // Here we allow either, so that our tests are independent of such variation.
        var semiIndex = contentType.indexOf(';');
        if (semiIndex > -1) { contentType = contentType.slice(0, semiIndex); }
        assert.equal(contentType, 'application/json');
    }

    // reuseable tests
    function auth(path, method) { // method (e.g., 'get') path requires auth
        // For delete method and the admin routes, we will require an admin user.
        method = method || 'get';
        var title = 'checks authorization for ' + path + ' ' + method;
        if (method === 'skip') { return it.skip(title); }
        it(title, function (done) {
            request({url: base + path, method: method, auth: {user: 'BAD'}}, function (error, res) {
                assert.ifError(error);
                assert.equal(res.statusCode, 401, res.statusMessage);
                done();
            });
        });
    }
    function maybeAuthed(path) { // media requires credentials, other get methods do not.
        var opts = {url: base + path};
        if (path.indexOf('media') !== -1) { opts.auth = credentials; }
        return opts;
    }
    // Define tests that get path multiple times, ensure mime type, and any optionalTests({response, body}),
    function page(path, optionalMime, optionalTests) {
        var data = {};
        it('get ' + path, function (done) {
            request(maybeAuthed(path), function (error, res, bod) {
                assert.ifError(error);
                data.response = res;
                data.body = bod;
                assert.equal(data.response.statusCode, 200, data.response.statusMessage);
                assertMime(data.response, optionalMime);
                done();
            });
        });
        if (optionalTests) { optionalTests(data); }
        it('multiple get ' + path, function (done) {
            // This isn't a load test. It's a smoke test that path can be called a lot on the same machine without something going seriously wrong.
            var start = Date.now();
            var n = 100;
            var uri = base + path;
            this.timeout(5 * 1000);
            async.times(n, function (n, ncb) {
                _.noop(n);
                request(uri, ncb);
            }, function (e) {
                assert.ifError(e);
                var elapsed = Date.now() - start;
                stats[path] = (n * 1000) / elapsed;
                done();
            });
        });
    }
    function upload(pathname, data, optionalExpected) {
        // if data.filename, we read that instead, and set data.buffer to the content, and data.mime
        var expectedResponse = optionalExpected || {status: 'ok'};
        var dir = path.dirname(pathname);
        // Two of these don't correspond to get's with the same name, and so use 'POST'. The rest are 'PUT' semantics.
        var method = _.contains(['/fbusr', '/pRefs'], dir) ? 'POST' : 'PUT';
        auth(pathname, ('/fbusr' === dir) ? 'skip' :  method); // FIXME: Don't skip auth for /fbusr
        it('uploads ' + pathname, function (done) {
            var body = {uri: base + pathname, method: method, auth: credentials};
            function testBody() {
                request(body, function (e, res, body) {
                    assert.ifError(e);
                    assert.equal(res.statusCode, 200, res.statusMessage);
                    assertMime(res); // Even if we post form data, the repsonse is json, ...
                    if (_.isString(body)) { body = JSON.parse(body); } // ... but request() doesn't parse it if we post formData.
                    assert.deepEqual(body, expectedResponse);
                    done();
                });
            }
            if (data.filename) {
                fs.readFile(path.join(__dirname, data.filename), function (e, buf) {
                    var basename = path.basename(data.filename), ext = path.extname(basename).slice(1);
                    assert.ifError(e);
                    data.buffer = buf;
                    data.mime = 'image/' + ext;
                    body.formData = {fileUpload: {value: buf, options: {filename: basename, contentType: data.mime}}};
                    testBody();
                });
            } else {
                body.json = data;
                testBody();
            }
        });
    }
    // Confirms that path can be DELETEd, after which a GET fails, and authorization is required.
    function deletes(path) {
        var uri = base + path;
        auth(path, 'delete');
        it('deletes ' + path, function (done) {
            request({uri: uri, method: 'DELETE', json: true, auth: credentials}, function (e, res, b) {
                assert.ifError(e);
                assert.equal(res.statusCode, 200, res.statusMessage);
                assertOk(b);
                // And now a GET produces file-not-found.
                request(maybeAuthed(path), function (e, res) {
                    assert.ifError(e);
                    assert.equal(res.statusCode, 404, res.statusMessage);
                    done();
                });
            });
        });
    }
    before(function (done) { // Start server if necessary
        this.timeout(10 * 1000);
        if (serverIsRunning()) { return done(); }
        console.log('Starting server.');
        // If we have to start our own server, we send its log to a file:
        // 1. We want to capture the output in case something goes wrong
        // 2. If we don't, the performance gets very very strange.
        var logStream = fs.createWriteStream('test.server.log');
        // Subtle. It turns out that logStream isn't immediately opened for writing, but spawn requires that it is open.
        // So the solution is to not spawn until the stream is truly open.
        logStream.on('open', function () {
            ourServer = shell.spawn('npm', ['start'], {stdio: ['pipe', logStream, logStream]});
            ourServer.on('exit', function (code) { if (code) { throw new Error("Server failed with code " + code + ". See test.server.log."); } });
            waitForChange(true, done);
        });
    });
    after(function (done) { // Shut down server if we started it
        console.log('Requests per second:'); // See comment for 'multiple get'.
        console.log(stats);
        this.timeout(5 * 1000);
        if (!ourServer) { return done(); }
        console.log('Stopping server.');
        shell.spawn('npm', ['stop']);
        waitForChange(false, done);
    });

    page('/', 'text/html; charset=utf-8', function (data) {
        var $;
        it('is parseable as html', function (done) {
            $ = cheerio.load(data.body);
            assert.ok($('head').is('head'));
            done();
        });
        it('has title', function () {
            assert.ok(_s.include($('title').text(), 'ki1r0y'));
        });
    });
    page('/favicon.ico', 'image/x-icon');
    var idtag = {}, paths = {};
    describe('/media', function () {
        var original = {filename: 'test.png'};
        paths.media = '/media/' + original.filename;
        upload(paths.media, original);
        auth(paths.media, 'skip');
        page(paths.media, 'image/png', function (data) {
            it(paths.media + ' matches upload', function () {
                // Using assert.ok instead of assert.equal, so that a failure doesn't print all the buffer data.
                // Alternatively, we could set encoding option in request and keep it a buffer.
                assert.ok(data.body === original.buffer.toString());
            });
        });
    });
    describe('nouns', function () {
        function makeIdtag(thing, kind, optionalLabel) {
            // Create the idtag and pathname we use for different kinds of things, and store it the test dictionaries. Answer idtag.
            var hash = crypto.createHash('sha1').update(JSON.stringify(thing)).digest('hex');
            var label = optionalLabel || kind;
            if (kind === 'place') { hash = 'G' + hash; }
            // FIXME: NO! place tags and fbusr tags must remain constant under different versions!!!! (e.g., repeated uses.)
            //console.log('idtag', thing, kind, optionalLabel, hash, label); // FIXME
            idtag[label] = hash;
            paths[label] = '/' + kind + '/' + idtag[label] + '.json';
            return hash;
        }
        var person = {firstname: 'test', lastname: 'user', username: 'test.user', gender: 'male', description: "testing"};
        var thing = {author: makeIdtag(person, 'fbusr'), nametag: 'thing1', desc: 'child thing', type: 'html'};
        var placeVersion = {author: idtag.fbusr, nametag: 'thing2', desc: 'parent thing', type: 'html', children: [{idtag: makeIdtag(thing, 'thing')}]};
        // Most of the data in a place is a duplicate of the top level version thing.
        // The place doesn't have the non-general stuff (type, children), and adds idvtag and versions.
        var place = {author: placeVersion.author, nametag: placeVersion.nametag, desc: placeVersion.desc,
                     idvtag: makeIdtag(placeVersion, 'thing', 'placeVersion'), versions: {}};
        place.versions[Date.now().toString()] = place.idvtag;
        describe('person', function () {
            upload(paths.fbusr, person, _.extend({scenes: []}, person));
        });
        describe('thing', function () {
            // Should we test materials: [aMediaId, {map: aMediaId}]?
            upload(paths.thing, {data: thing}); // Note extra 'data' wrapping
            page(paths.thing, null, function (data) {
                it('thing answers the uploaded data', function () {
                    assert.equal(data.body, JSON.stringify(thing));
                });
            });

            upload(paths.placeVersion, {data: placeVersion, flag: true});
            page(paths.placeVersion, null, function (data) {
                it('place version thing answers the uploaded data', function () {
                    assert.equal(data.body, JSON.stringify(placeVersion));
                });
            });

            var thumb = {filename: 'kilroy-21-reduced.png'};
            paths.thumb = '/thumb/' + idtag.thing + '.png';
            upload(paths.thumb, thumb);
            page(paths.thumb, 'image/png', function (data) {
                it(paths.thumb + ' matches upload', function () {
                    assert.ok(data.body === thumb.buffer.toString());
                });
            });
            it('defines multiple thumb ids with a single upload');
        });
        describe('place', function () {
            paths.pRefs = '/pRefs/' + makeIdtag(place, 'place') + '.json';

            // It is the duty of the client to:
            // 1. upload the place data in the same way it uploads things (but to a place path)...
            upload(paths.place, {data:  place});
            // 2. upload a list of the referenced things to the pRefs path for the same place idtag.
            // (This double-upload arrangement makes server's job a bit easier, because the pRefs data is stored separately.)
            upload(paths.pRefs, {data: [ idtag.thing, idtag.placeVersion ]});

            page(paths.place, null, function (data) {
                it('place answers the uploaded data', function () {
                    assert.equal(data.body, JSON.stringify(place));
                });
            });
        });
        describe('queries', function () {
            page('/q/scenesContaining/' + idtag.thing, null, function (data) {
                it(idtag.thing + ' refs includes place', function () {
                    assert.ok(_.contains(JSON.parse(data.body), idtag.place));
                });
            });
            page('/q/hasWord/CHILD', null, function (data) {
                it('child citations includes thing', function () {
                    assert.ok(_.contains(JSON.parse(data.body), idtag.thing));
                });
            });
            page('/q/hasWord/PARENT', null, function (data) {
                it('parent citations includes place', function () {
                    assert.ok(_.contains(JSON.parse(data.body), idtag.place));
                });
            });
            page('/q/hasWord/136notawurd8517', null, function (data) {
                it('queries for non-words do not fail', function () {
                    assert.ok(!JSON.parse(data.body).length);
                });
            });
            function textSearch(id, data, isThing) {
                var text = data.desc;
                var query = '/q/search/' + text.toUpperCase();
                page(query, null, function (result) {
                    it('finds ' + data.nametag + ' when searching for its description', function () {
                        var item = _.findWhere(JSON.parse(result.body), {idvtag: id});
                        assert.equal(item.sceneIdtag, idtag.place);
                        assert.equal(item.sceneNametag, place.nametag);
                        assert.equal(item.userIdtag, idtag.fbusr);
                        assert.equal(item.objectIdtag, isThing ? id : undefined); // wasteful? should we change this result?
                        assert.equal(item.objectNametag, isThing ? thing.nametag : undefined);
                        // FIXME: how do we get timestamp for isThing
                    });
                });
            }
            textSearch(idtag.thing, thing, true);
            textSearch(idtag.placeVersion, placeVersion);
            page('/q/search/136notawurd8517', null, function (data) {
                it('searches for non-words do not fail', function () {
                    assert.ok(!JSON.parse(data.body).length);
                });
            });
            // FIXME: expose timeline data, too.
        });
        describe('cleanup', function () {
            deletes(paths.thing);
            deletes(paths.placeVersion);
            deletes(paths.place);
            deletes(paths.thumb);
            deletes('/refs/' + idtag.thing + '.json');
            deletes('/refs/' + idtag.placeVersion + '.json');
            deletes(paths.fbusr);
            deletes(paths.media);
        });
    });
});
