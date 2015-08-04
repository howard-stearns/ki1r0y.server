"use strict";
/*jslint browser: true, devel: true, vars: true, plusplus: true, forin: true */
/// Interface with Facebook and Google Analytics.
/// Copyright (c) 2014 Beyond My Wall. All rights reserved until we get a clue.
/// Google Analytics and Facebook are copyrighted by their respective owners.
var FB, ga;  // Defined by the two third parties.
var doLogin; // Must be defined by our consuming code.

/************************** GOOGLE ANALYTICS ************************************/
/* startup initialization */
(function(i,s,o,g,r,a,m){i['GoogleAnalyticsObject']=r;i[r]=i[r]||function(){
	(i[r].q=i[r].q||[]).push(arguments)},i[r].l=1*new Date();a=s.createElement(o),
						 m=s.getElementsByTagName(o)[0];a.async=1;a.src=g;m.parentNode.insertBefore(a,m)
						})(window,document,'script','//www.google-analytics.com/analytics.js','ga');
switch (location.host) { // Create the ga object for the appropriate account.
case 'junkshop.co':
	ga('create', 'UA-44205637-3', 'junkshop.co'); break;
case 'beyondmywall.com':
	ga('create', 'UA-44205637-2', 'beyondmywall.com'); break;
default:
	ga('create', 'UA-44205637-1', 'fe100.net'); 
}
var dimmap = { // The custom dimensions we use for segmentation. Propnames are our names, values are Google's.
	scene: 'dimension1',   // hit scope
	author: 'dimenions2',  // hit
	fbGender: 'dimension3',// session scope
	userId: 'dimension4',  // session
	plugin: 'dimension5'   // session
};

function dimension(name, val) { // Set a custom dimension for segmentation, using the above map.
	console.log('dimension', name, val);
	ga('set', dimmap[name], val);
}
function canonicalLocation(url, title) { 
	// Update Google Analytic configuration for all subsequent events (until changed again).
	// These are canonical values without version, action, etc., and so may be different from window.location & document.title
	var path = url.slice(location.origin.length);
	console.log('ga set location', url, 'page', path, 'title', title);
	ga('set', 'location', url);
	ga('set', 'page', path);
	ga('set', 'title', title);
}
var LoadStart = new Date();
function timing(category, action, start, label) { // Report a timing event.
	if (start === undefined) { start = LoadStart; }
	var elapsed = new Date().getTime() - start.getTime();
	console.log('timing', category, action, elapsed, label);
	ga('send', 'timing', category, action, elapsed, label);
}
function social(platform, action, targetUrl) { // Report a social event: (un)like, comment
	console.log('social', platform, action, targetUrl);
	ga('send', 'social', platform, action, targetUrl);
}
function logEvent(category, action, label, value) { // Report a generic event in categories: admin, system, create, discovery, communication
	console.log('event', category, action, label, value);
	ga('send', 'event', category, action, label, value);
}
function page() { // Report a virtual page view. 
	// Info normally set or reset by canonicalLocation must already be correct.
	ga(function (tracker) {  // because that's the way 'get' works...
		console.log('page', tracker.get('page'), tracker.get('title'));
	});
	ga('send', 'pageview');
}

/************************** FACEBOOK ************************************/
// startup initialization
window.fbAsyncInit = function () {
    var app = {
		appId      : FBAPPID,
        //version    : 'v2.3', // Modern docs say do this. Is our old stuff ready?
		status     : true, // check login status
		cookie     : true, // enable cookies to allow the server to access the session
		xfbml      : true  // parse XFBML
    };
	app.channelUrl = '//www.ki1r0y.com/channel.html';
	console.log('FB init', app);
	FB.init(app);
	FB.Event.subscribe('auth.statusChange', doLogin); // Analogous to putting onlogin="doLogin" on the fb:login-button element.
	// Callbacks for Like and Comment.
	FB.Event.subscribe('edge.create', function (targetUrl) {
		social('facebook', 'like', targetUrl);
	});
	FB.Event.subscribe('edge.remove', function (targetUrl) {
		social('facebook', 'unlike', targetUrl);
	});
	FB.Event.subscribe('comment.create', function (targetUrl) {
		social('facebook', 'comment', targetUrl);
	});
};
// Load the Facebook SDK Asynchronously
(function (d, scriptTag, id) {
	if (!FBAPPID) { // Running locally for testing.
		window.setTimeout(function () { doLogin({status: 'connected'}); }, 100); // synthesize login callbck
	} else {
		var js, id = 'facebook-jssdk', ref = d.getElementsByTagName(scriptTag)[0];
		if (d.getElementById(id)) { return; }
		js = d.createElement(scriptTag); js.id = id;
        js.async = true; // Maybe this is the default in modern versions?
		js.src = "//connect.facebook.net/en_US/all.js";
        //js.src = "//connect.facebook.net/en_US/sdk.js";  // Modern docs say to use this instead.
		ref.parentNode.insertBefore(js, ref);
	}
}(document, 'script', 'facebook-jssdk'));

