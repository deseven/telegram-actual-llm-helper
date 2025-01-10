# telegram-actual-llm-helper
A bot designed to assist with logging expenses in [Actual Budget](https://actualbudget.org), leveraging the capabilities of ChatGPT or other large language models (LLMs). Send your spendings to the bot in any form and they will magically appear as transactions in Actual Budget. Only text is supported ATM.

## Requirements
 - Actual Budget (duh)
 - any environment that can run node.js
 - 64MB of RAM
 - any reverse proxy web server that can handle SSL (for incoming messages webhook)

## Installation
#### Prerequisites
1. Create a new bot with [@BotFather](https://t.me/BotFather), copy bot token.
2. Clone this repo or download the code archive.
3. Copy `.env.example` to `.env` and edit it, follow the comments.
4. Set up a reverse proxy so your webhook URL would actually be available via HTTPS.

#### With docker compose (recommended)
5. Run `docker compose up -d`.

#### Manually
5. Install node.js 18 (higher versions could work too, untested).
6. Run `npm i`.
7. Run `npm run start`.

## Usage
1. Send `/start` to the bot, it should answer with an introductory message.
2. Type or paste any info about transactions you had. Almost anything should work, starting from a simple amount you spent and ending with complex messages (obviously depends on capabilities of the model you use). You can also mention multiple spendings in a single message.

## Notes
 - default category and account you set in the .env file should actually exist in Actual Budget, the bot won't create them for you
 - all incoming spendings that have currency other than the one you set in the `.env` file will be converted to it using the exchange rates from [fawazahmed0/exchange-api](https://github.com/fawazahmed0/exchange-api)
 - on the `info` log level, bot outputs all user IDs of all incoming messages to stdout, in case you need a quick way to get them
 - `debug` level could also be useful if you want to track what exactly is being sent to the model and to the app
 - there's a `/health` endpoint that could be used for monitoring