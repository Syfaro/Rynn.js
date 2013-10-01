var persist = require('persist')
  , type = persist.type;

var models = {
	Action: persist.define('Action', {
		'tweet_id': type.STRING,
		'screen_name': type.STRING,
		'text': type.STRING
	}),
	Blacklist: persist.define('Blacklist', {
		'screen_name': type.STRING
	})
};

module.exports = models;