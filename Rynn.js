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

var twit = require('twit')
  , fs = require('fs')
  , async = require('async')
  , persist = require('persist')
  , type = persist.type
  , models = require('./models');

var app = function(apps, database) {
	verifyAccounts(apps, function(err, accounts) {
		if(err) {
			throw err;
		}

		getDatabase(database, function(err, connection) {
			startStreams(accounts.accounts, connection);

			setTimeout(function() {
				startBlacklistChecks(apps, connection);
			}, 120000);
		});
	});
};

var current = {};

var verifyAccounts = function(apps, callback) {
	var services = {};
	var accountNames = [];

	async.eachSeries(Object.keys(apps), function(item, done) {
		current[item] = 0;
		apps[item].service = item;
		verifyServices(apps[item], function(err, service) {
			services[item] = service;
			accountNames.concat(service.accountNames);
			done(null);
		});
	}, function(err) {
		callback(err, {
			accounts: services,
			accountNames: accountNames
		});
	});
};

var verifyServices = function(service, callback) {
	var accounts = [];
	var accountNames = [];
	async.eachSeries(service.accounts, function(item, done) {
		var T = new twit({
			consumer_key: item.consumer_key,
			consumer_secret: item.consumer_secret,
			access_token: item.access_token,
			access_token_secret: item.access_token_secret
		});

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

var getDatabase = function(database, callback) {
	persist.connect({
		driver: database.driver,
		user: database.user,
		password: database.password,
		database: database.name,
		filename: database.filename,
		trace: database.trace
	}, function(err, connection) {
		var schema = fs.readFileSync('schema.sql', 'utf-8');
		connection.runSql(schema, function(err) {
			callback(err, connection);
		});
	});
};

var startStreams = function(apps, database) {
	async.eachSeries(Object.keys(apps), function(item, callback) {
		startStream(apps[item], database, callback);
	});
};

var startStream = function(service, database) {
	var T = new twit({
		consumer_key: service.accounts[0].consumer_key,
		consumer_secret: service.accounts[0].consumer_secret,
		access_token: service.accounts[0].access_token,
		access_token_secret: service.accounts[0].access_token_secret
	});

	var stream = T.stream('statuses/filter', {
		track: service.keywords,
		language: service.language
	});

	service.stream = stream;

	stream.on('tweet', function(tweet) {
		try {
			if(service.accountNames.indexOf(tweet.user.screen_name) !== -1) {
				return; // our own account
			}
		} catch (e) {
			return;
		}

		try {
			if(tweet.retweeted_status) {
				return; // it's a retweet
			}
		} catch (e) {
			return;
		}

		isBlacklisted(tweet.user.screen_name, database, function(result) {
			if(!result) {
				service.valid(tweet, function(result) {
					if(result) {
						runActionOnTweet(service, database, tweet);
					}
				});
			}
		});
	});
};

var addToBlacklist = function(name, database, callback) {
	new models.Blacklist({
		screen_name: name
	}).save(database, function(err) {
		callback(err);
	});
};

var isBlacklisted = function(name, database, callback) {
	models.Blacklist.where('screen_name = ?', name).all(database, function(err, people) {
		if(!people || !people.getById(0)) {
			return callback(false);
		}
		callback(true);
	});
};

var runActionOnTweet = function(service, database, tweet, loops) {
	loops = (loops === undefined) ? 0 : loops;

	if((loops + 1) > service.accounts.length) {
		service.stream.stop();
	}

	var T = new twit({
		consumer_key: service.accounts[current[service.service]].consumer_key,
		consumer_secret: service.accounts[current[service.service]].consumer_secret,
		access_token: service.accounts[current[service.service]].access_token,
		access_token_secret: service.accounts[current[service.service]].access_token_secret
	});

	service.callback(T, tweet, database, function(err) {
		if(err) {
			if(JSON.stringify(err).indexOf('suspended') !== -1 || JSON.stringify(err).indexOf('Twittering') !== -1) {
				if((current[service.service] + 1) > (service.accounts.length - 1)) {
					current[service.service] = 0;
				} else {
					current[service.service]++;
				}
				runActionOnTweet(service, database, tweet, (loops + 1));
			} else {
				console.log(err);
			}
		} else {
			new models.Action({
				tweet_id: tweet.id_str,
				screen_name: tweet.user.screen_name,
				text: tweet.text
			}).save(database, function(){});
		}
	});
};

var startBlacklistChecks = function(apps, database) {
	async.eachSeries(Object.keys(apps), function(item, callback) {
		async.eachSeries(apps[item].accounts, function(account, done) {
			var T = new twit({
				consumer_key: account.consumer_key,
				consumer_secret: account.consumer_secret,
				access_token: account.access_token,
				access_token_secret: account.access_token_secret
			});

			T.get('statuses/mentions_timeline', {
				count: 5
			}, function(err, data) {
				async.eachSeries(data, function(mention, checked) {
					if(!/^@(\S+) STOP ?$/.test(mention.text)) {
						return;
					}

					isBlacklisted(mention.user.screen_name, database, function(result) {
						if(!result) {
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