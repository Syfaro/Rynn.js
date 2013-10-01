/*
Copyright (c) 2013, Syfaro Warraw
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR
ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

// for Twitter stuff
var twit = require('twit')
// for loading files n stuff
  , fs = require('fs')
// for processing things async
  , async = require('async')
// so we can use SQL easily, and without having to deal with multiple types
  , persist = require('persist')
// models for persist
  , models = require('./models');

/**
 * Entry point for the library
 * @param  {object} apps     Object of types and accounts
 * @param  {object} database Database configuration
 */
var app = function(apps, database) {
	// check for the accounts that work
	verifyAccounts(apps, function(err, accounts) {
		if(err) {
			throw err;
		}

		// get a connection to the database
		getDatabase(database, function(err, connection) {
			// now that we've got a connection, start streaming from Twitter
			startStreams(accounts.accounts, connection);

			// start checking every 2 minutes to see if a user wants to STOP
			setTimeout(function() {
				startBlacklistChecks(apps, connection);
			}, 120000);
		});
	});
};

// contains the account that is currently being used
var current = {};

/**
 * Checks if all accounts are working
 * @param  {object}   apps     Object of accounts and types
 * @param  {Function} callback callback of err, results when finished
 */
var verifyAccounts = function(apps, callback) {
	// all of the different 'services'
	var services = {};
	// all of the account names (for easy access later)
	var accountNames = [];

	// go through all the 'services'
	async.eachSeries(Object.keys(apps), function(item, done) {
		// set this for later use
		current[item] = 0;
		// sets the name of the item for access with async each
		apps[item].service = item;
		// verifies all the accounts for the 'service'
		verifyServices(apps[item], function(err, service) {
			// set the original one to the new one with only working accounts
			services[item] = service;
			// add the account names to the accountNames array
			accountNames.concat(service.accountNames);
			// async callback
			done(null);
		});
	}, function(err) {
		callback(err, {
			accounts: services,
			accountNames: accountNames
		});
	});
};

/**
 * Checks if the accounts are working for a service
 * @param  {object}   service  Object for a service
 * @param  {Function} callback callback of err, result when finished
 */
var verifyServices = function(service, callback) {
	// all the accounts
	var accounts = [];
	// all the account names
	var accountNames = [];

	// go through each account
	async.eachSeries(service.accounts, function(item, done) {
		// Twitter object for account
		var T = new twit({
			consumer_key: item.consumer_key,
			consumer_secret: item.consumer_secret,
			access_token: item.access_token,
			access_token_secret: item.access_token_secret
		});

		// Twitter API method for verifying an account works
		T.get('account/verify_credentials', {
			include_entities: false,
			skip_status: true
		}, function(err, data) {
			if(err) {
				done(null);
			} else {
				accounts.push(item);
				accountNames.push(data.screen_name);
				done(null);
			}
		});
	}, function(err) {
		var data = {};
		data.service = service.service;
		data.valid = service.valid;
		data.accounts = accounts;
		data.accountNames = accountNames;
		data.keywords = service.keywords;
		data.language =  service.language;
		data.callback =  service.callback;

		callback(err, data);
	});
};

/**
 * Gets a connection to the database
 * @param  {object}   database Database configuration
 * @param  {Function} callback callback containing err and connection
 * @return {[type]}            [description]
 */
var getDatabase = function(database, callback) {
	persist.connect({
		driver: database.driver,
		user: database.user,
		password: database.password,
		database: database.name,
		filename: database.filename,
		trace: database.trace
	}, function(err, connection) {
		// load our schema to make sure the tables exist
		var schema = fs.readFileSync('schema.sql', 'utf-8');
		connection.runSql(schema, function(err) {
			callback(err, connection);
		});
	});
};

/**
 * Starts the streams for each 'service'
 * @param  {object} apps     Services object
 * @param  {persist} database persist object
 */
var startStreams = function(apps, database) {
	// go through each service
	async.eachSeries(Object.keys(apps), function(item, callback) {
		// start the stream and processing for it
		startStream(apps[item], database, callback);
	});
};

/**
 * Starts a stream for a service
 * @param  {object} service  Service object
 * @param  {persist} database persist object
 */
var startStream = function(service, database) {
	// first account, as long as the account will log in, streams work
	var T = new twit({
		consumer_key: service.accounts[0].consumer_key,
		consumer_secret: service.accounts[0].consumer_secret,
		access_token: service.accounts[0].access_token,
		access_token_secret: service.accounts[0].access_token_secret
	});

	// start the stream
	var stream = T.stream('statuses/filter', {
		track: service.keywords,
		language: service.language
	});

	// put a reference to the stream in the object so we can stop it later
	service.stream = stream;

	// runs whenever a Tweet is found in the stream
	stream.on('tweet', function(tweet) {
		try {
			// check if the Tweet is one of our own
			if(service.accountNames.indexOf(tweet.user.screen_name) !== -1) {
				return; // our own account
			}
		} catch (e) {
			return;
		}

		try {
			// check if it is a retweet
			if(tweet.retweeted_status) {
				return; // it's a retweet
			}
		} catch (e) {
			return;
		}

		// make sure the user isn't blacklisted
		isBlacklisted(tweet.user.screen_name, database, function(result) {
			// if not blacklisted,
			if(!result) {
				// check if the Tweet matches
				service.valid(tweet, function(result) {
					// if it does,
					if(result) {
						// run the action associated with the service
						runActionOnTweet(service, database, tweet);
					}
				});
			}
		});
	});
};

/**
 * Adds a user to the blacklist
 * @param {string}   name     The user's screen_name
 * @param {persist}   database persist object
 * @param {Function} callback callback with err
 */
var addToBlacklist = function(name, database, callback) {
	new models.Blacklist({
		screen_name: name
	}).save(database, function(err) {
		callback(err);
	});
};

/**
 * Checks if a user is blacklisted
 * @param  {string}   name     The user's screen_name
 * @param  {persist}   database persist object
 * @param  {Function} callback callback with boolean representing if the user is blacklisted
 */
var isBlacklisted = function(name, database, callback) {
	models.Blacklist.where('screen_name = ?', name).all(database, function(err, people) {
		if(!people || !people.getById(0)) {
			return callback(false);
		}
		callback(true);
	});
};

/**
 * Function that is called when trying to execute the Tweet
 * @param  {object} service  Services object
 * @param  {persist} database persist object
 * @param  {object} tweet    Tweet
 * @param  {int} loops    Number of times it has been tried
 */
var runActionOnTweet = function(service, database, tweet, loops) {
	// make sure loops is an integer
	loops = (loops === undefined) ? 0 : loops;

	// if a loop number is higher than the accounts number, there are no accounts left
	if((loops + 1) > service.accounts.length) {
		service.stream.stop();
	}

	// Twitter object
	var T = new twit({
		consumer_key: service.accounts[current[service.service]].consumer_key,
		consumer_secret: service.accounts[current[service.service]].consumer_secret,
		access_token: service.accounts[current[service.service]].access_token,
		access_token_secret: service.accounts[current[service.service]].access_token_secret
	});

	// call the function
	service.callback(T, tweet, database, function(err) {
		// if the function had an error,
		if(err) {
			// check if the error was because of Twitter rate limits
			if(JSON.stringify(err).indexOf('suspended') !== -1 || JSON.stringify(err).indexOf('Twittering') !== -1) {
				// move the current to the next available account
				if((current[service.service] + 1) > (service.accounts.length - 1)) {
					current[service.service] = 0;
				} else {
					current[service.service]++;
				}
				// try and run it again
				runActionOnTweet(service, database, tweet, (loops + 1));
			} else {
				console.log(err);
			}
		} else {
			// the function was successful, log the action to the database
			new models.Action({
				service: service.service,
				tweet_id: tweet.id_str,
				screen_name: tweet.user.screen_name,
				text: tweet.text
			}).save(database, function(){});
		}
	});
};

/**
 * Starts a check for new blacklist entries
 * @param  {object} apps     Object of services
 * @param  {persist} database persist database
 */
var startBlacklistChecks = function(apps, database) {
	// go through each service
	async.eachSeries(Object.keys(apps), function(item, callback) {
		// and each account on each service
		async.eachSeries(apps[item].accounts, function(account, done) {
			// Twitter object
			var T = new twit({
				consumer_key: account.consumer_key,
				consumer_secret: account.consumer_secret,
				access_token: account.access_token,
				access_token_secret: account.access_token_secret
			});

			// get mentions
			T.get('statuses/mentions_timeline', {
				count: 5
			}, function(err, data) {
				// go through each mention
				async.eachSeries(data, function(mention, checked) {
					// if the user doesn't match the STOP regex,
					if(!/^@(\S+) STOP ?$/.test(mention.text)) {
						// stop processing
						return;
					}

					// check if user is blacklisted
					isBlacklisted(mention.user.screen_name, database, function(result) {
						// if the user isn't already blacklisted,
						if(!result) {
							// add to the blacklist
							addToBlacklist(mention.user.screen_name, function(err) {
								checked(err);
							});
						}
					});
				}, function(err) {
					done(null);
				});
			});
		});
	});
};

module.exports = app;