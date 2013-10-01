// require the library
var Rynn = require('../Rynn');

// different things we want to the use the bot for
var services = {
	'media': {
		// we want this service to be enabled
		enabled: true,
		// a string to search on the Twitter Streaming API
		keywords: 'Minecraft',
		// only in this language
		language: 'en',
		// validate that this Tweet is worth calling
		valid: function(data, callback) {
			// it contains a picture
			if(data.entities && data.entities.media && data.entities.media.length > 0) {
				return callback(true);
			}

			// it doesn't contain a picture
			callback(false);
		},
		callback: function(twit, data, database, callback) {
			// retweet the tweet
			twit.post('statuses/retweet/' + data.id_str, function(err) {
				// callback the error, so it can retry the action on another account
				// if the reason for failing was that the account was suspended
				// or that it's reached the rate limit
				callback(err);
			});
		},
		accounts: [
			{
				// put all of your accounts in here
				consumer_key: '',
				consumer_secret: '',
				access_token: '',
				access_token_secret: ''
			}
		]
	}
};

// database configuration
var database = {
	// if you want to use something other than sqlite3, you need to install it
	driver: 'sqlite3',
	filename: 'actions.db'
};

// and now let's start it
Rynn(services, database);