"use strict";
/*jslint node: true */
var assert = require('assert');
var shell = require('child_process');
var async = require('async');
var request = require('request');
var cheerio = require('cheerio');

describe('Kilroy', function () {
	var port = 3000, ourServer;
	function serverIsRunning() {
		return shell.spawnSync('curl', ['http://localhost:' + port]).status === 0;
	}
	function waitForChange(initiallyRunning, cb) {
		var count = 0, loop = initiallyRunning ? async.doWhilst : async.doUntil;
		loop(function (icb) {
			if (count++ > 10) { console.log('failed to change'); cb(new Error('Server failed to shut down after 10 seconds.')); }
			setTimeout(icb, 200);
		}, serverIsRunning, cb);
	}
	before(function (done) {
		this.timeout(2 * 1000);
		if (serverIsRunning()) { return done(); }
		ourServer = shell.spawn('npm', ['start']);
		waitForChange(false, done);
	});
	after(function (done) {
		this.timeout(2 * 1000);
		if (!ourServer) { return done(); }
		shell.spawn('npm', ['stop']);
		waitForChange(true, done);
	});
	describe('index', function () {
		var response, body, $;
		it('does not fail', function (done) {
			request('http://localhost:' + port, function (error, res, bod) {
				assert.ifError(error);
				response = res;
				body = bod;
				done();
			});
		});
		it('has ok status', function () {
			assert.equal(response.statusCode, 200, response.statusMessage);
		});
		it('has html utf-8 mime type', function () {
			assert.equal(response.headers['content-type'], 'text/html; charset=utf-8');
		});
		it('is parseable as html', function (done) {
			$ = cheerio.load(body);
			assert.ok($('head').is('head'));
			done();
		});
		it('has title', function () {
			assert.equal($('title').text(), 'Express');
		});
	});
});
