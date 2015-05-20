"use strict";
/*jslint node: true */
// Logs info to logger as if it was an http request. Must be configured to use an express logger (such as morgan).

function noop () {}
var logger, defaultMethod;
exports.configure = function configure(props) { // arg is {logger, method} or just logger
	logger = (typeof props === 'function') ? props : props.logger;
	defaultMethod = props.method || 'TRACE';
};
exports.info = function info(pseudoReq) { // arg is {url, statusCode, headers} (and may be side-effected!) or just url (where, in the style of most express stuff, url is really a pathname)
	var req = (typeof pseudoReq === 'string') ? {url: pseudoReq} : pseudoReq;
	var res = {statusCode: req.statusCode || 200, _header: {}};
	req.method = req.method || defaultMethod;
	req.headers = req.headers || {};
	req.httpVersionMajor = req.httpVersionMinor = 1;
	logger(req, res, noop);
};

