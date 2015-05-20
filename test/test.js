"use strict";
/*jslint node: true */
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

describe('server', function () {
	var port = 3000, base = 'http://localhost:' + port, ourServer;
	var stats = {};
	function serverIsRunning() {
		return shell.spawnSync('curl', ['http://localhost:' + port]).status === 0;
	}
	function waitForChange(initiallyRunning, cb) {
		var loop = initiallyRunning ? async.doWhilst : async.doUntil;
		loop(function (icb) {
			setTimeout(icb, 1000);
		}, serverIsRunning, cb);
	}
	function assertOk(res) { assert.deepEqual(res, {status: 'ok'}); }
	function assertMime(res, expectedNonJson) {
		var contentType = res.headers['content-type'];
		if (expectedNonJson) { return assert.equal(contentType, expectedNonJson); }
		// The content-type standard is a bit vague. Charset is an optional addition to content-type, and elsewhere
		// that application/json uses utf-8. So, do we have to specify charset?
		// In fact, express-static sets 'content-type: application/json' for json files (no charset),
		// while express Response.send sets 'content-type: application/json; charset=utf-8'.
		// Here we allow either, so that our tests are independent of such variation.
		var semiIndex = contentType.indexOf(';');
		if (semiIndex > -1) { contentType = contentType.slice(0, semiIndex); }
		assert.equal(contentType, 'application/json');
	}
	function auth(path, method) {
		// For delete method and the admin routes, we will require an admin user.
		it('checks authorization for ' + path + ' ' + (method || 'get'));
	}
	function page(path, optionalMime, optionalTests) { // get path, ensure mime type, and define tests(body)
		var data = {};
		it('get ' + path, function (done) {
			// Sometimes the optionalMime isn't known at the time we define the tests, but is known at the time they are run.
			// To support that, optionalMime can be an object (that gets side-effected while running some earlier test), whose 
			// 'type' property should be the expected type when the test is run.
			if (optionalMime && !_.isString(optionalMime)) { optionalMime = optionalMime.type; }
			request(base + path, function (error, res, bod) {
				assert.ifError(error);
				data.response = res;
				data.body = bod;
				assert.equal(data.response.statusCode, 200, data.response.statusMessage);
				assertMime(data.response, optionalMime);
				done();
			});
		});
		it('multiple get ' + path, function (done) {
			// This isn't a load test. It's a smoke test that path can be called a lot on the same machine without something going seriously wrong.
			var start = Date.now();
			var n = 100;
			var uri = base + path;
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
		if (optionalTests) { optionalTests(data); }
	}
	function upload(pathname, data, optionalExpected) { // if data.filename, we read that instead, and set data.buffer to the content, and data.type
		var expectedResponse = optionalExpected || {status: 'ok'};
		var expectedMime = null; // see assertMime
		auth(pathname, 'post');
		it('uploads ' + pathname, function (done) {
			var body = {uri: base + pathname, method: 'POST'};
			function testBody() {
				request(body, function (e, res, b) {
					assert.ifError(e);
					assert.equal(res.statusCode, 200, res.statusMessage);
					assertMime(res, expectedMime);
					if (_.isString(b)) { b = JSON.parse(b); } // We post form data, and the repsonse is json (see previous line), but request() doesn't parse it.
					assert.deepEqual(b, expectedResponse);
					done();
				});
			}
			if (data.filename) {
				fs.readFile(path.join(__dirname, data.filename), function (e, buf) {
					var basename = path.basename(data.filename), ext = path.extname(basename).slice(1);
					assert.ifError(e);
					data.buffer = buf;
					data.type = 'image/' + ext;
					body.formData = {fileUpload: {value: buf, options: {filename: basename, contentType: data.type}}};
					testBody();
				});
			} else {
				body.json = data;
				testBody();
			}
		});
	}
	function deletes(path) {
		var uri = base + path;
		auth(path, 'delete');
		it('deletes ' + path, function (done) {
			request({uri: uri, method: 'DELETE', json: true}, function (e, res, b) {
				assert.ifError(e);
				assert.equal(res.statusCode, 200, res.statusMessage);
				assertOk(b);
				request(uri, function (e, res) {
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
		// If we have to start our own server, we send its log to a file:
		// 1. We want to capture the output in case something goes wrong
		// 2. If we don't, the performance gets very very strange.
		var logStream = fs.createWriteStream('test.server.log');
		// Subtle. It turns out that logStream isn't immediately opened for writing, but spawn requires that it is open.
		// So the solution is to not spawn until the stream is truly open.
		logStream.on('open', function () {
			ourServer = shell.spawn('npm', ['start'], {stdio: ['pipe', logStream, logStream]});
			waitForChange(false, done);
		});
	});
	after(function (done) { // Shutd down server if we started it
		console.log('Requests per second:'); // See comment for 'multiple get'.
		console.log(stats);
		this.timeout(5 * 1000);
		if (!ourServer) { return done(); }
		shell.spawn('npm', ['stop']);
		waitForChange(true, done);
	});

	page('/', 'text/html; charset=utf-8', function (data) {
		var $;
		it('is parseable as html', function (done) {
			$ = cheerio.load(data.body);
			assert.ok($('head').is('head'));
			done();
		});
		it('has title', function () {
			assert.equal($('title').text(), 'Ki1r0y');
		});
	});
	page('/favicon.ico', 'image/x-icon');
	var idtag = {}, paths = {};
	describe('/media', function () {
		var original = {filename: 'test.png'};
		paths.media = '/media/' + original.filename;
		upload(paths.media, original);
		auth(paths.media);
		page(paths.media, original, function (data) {
			it(paths.media + ' matches upload', function () {
				assert.ok(data.body === original.buffer.toString()); // Alternatively, we could set encoding option in request and keep it a buffer.
			});
		});
	});
	describe('nouns', function () {
		function makeIdtag(thing, kind, optionalLabel) {
			var hash = crypto.createHash('md5').update(JSON.stringify(thing)).digest('hex');
			var label = optionalLabel || kind;
			if (kind === 'place') { hash = 'G' + hash; }
			// FIXME: NO! place tags must remain constant under different versions!!!! (e.g., repeated uses.)
			//console.log('idtag', thing, kind, optionalLabel, hash, label); // FIXME
			idtag[label] = hash;
			paths[label] = '/' + kind + '/' + idtag[label] + '.json';
			return hash;
		}
		var person = {firstname: 'test', lastname: 'user', username: 'test.user', gender: 'male', description: "testing"};
		var thing = {author: makeIdtag(person, 'fbusr'), nametag: 'thing2', desc: 'child thing', type: 'html'};
		var placeVersion = {author: idtag.fbusr, nametag: 'thing1', desc: 'parent thing', type: 'html', children: [{idtag: makeIdtag(thing, 'thing')}]};
		var place = {author: idtag.fbusr, nametag: 'place', desc: 'a test place', idvtag: makeIdtag(placeVersion, 'thing', 'placeVersion'), versions: {}};
		place.versions[Date.now().toString()] = place.idvtag;
		describe('person', function () {
			upload(paths.fbusr, person, _.extend({scenes: []}, person));
		});
		describe('thing', function () {
			// Should we test materials: [aMediaId, {map: aMediaId}]?
			upload(paths.thing, {data: thing}); // Note extra 'data' wrapping
			page(paths.thing);

			upload(paths.placeVersion, {data: placeVersion, flag: true});
			page(paths.placeVersion);

			var thumb = {filename: 'kilroy-21-reduced.png'};
			paths.thumb = '/thumb/' + idtag.thing + '.png';
			upload(paths.thumb, thumb);
			page(paths.thumb, thumb, function (data) {
				it(paths.thumb + ' matches upload', function () {
					assert.ok(data.body === thumb.buffer.toString());
				});
			});
			it('defines multiple thumb ids with a single upload');
		});
		describe('place', function () {
			paths.pRefs = '/pRefs/' + makeIdtag(place, 'place') + '.json';
			upload(paths.place, {data:  place});
			page(paths.place, place);
			upload(paths.pRefs, {data: [ idtag.thing, idtag.placeVersion ]});
			page('/scenes/' + idtag.thing + '.json', null, function (data) {
				it(idtag.thing + ' refs includes place', function () {
					assert.ok(_.contains(JSON.parse(data.body), idtag.place));
				});
			});
			page('/citations/THING2', null, function (data) {
				it('thing2 (title) citations includes thing', function () {
					//console.log('thing2', data.body);
					assert.ok(_.contains(JSON.parse(data.body), idtag.thing));
				});
			});
			page('/citations/PLACE', null, function (data) {
				it('thing1 (place version) citations includes place', function () {
					//console.log('thing1', data.body);
					assert.ok(_.contains(JSON.parse(data.body), idtag.place));
				});
			});
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
