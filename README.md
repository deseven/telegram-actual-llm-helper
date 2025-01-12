# telegram-actual-llm-helper
A bot designed to assist with logging expenses and deposits in [Actual Budget](https://actualbudget.org), leveraging the capabilities of ChatGPT or other large language models (LLMs). Send your transactions to the bot in any form and they will magically appear as expenses or deposits in Actual Budget. The bot also automatically converts amounts to your default currency using relevant exchange rates (thanks to [fawazahmed0/exchange-api](https://github.com/fawazahmed0/exchange-api)).

**Showcase Video:** [Watch the demo here](https://d7.wtf/s/telegram-actual-llm-helper.mp4)

## Requirements
 - Actual Budget (duh)
 - access to any LLM with OpenAI-compatible API
 - any environment that can run node.js
 - 64MB of RAM

## Installation
#### Prerequisites
1. Create a new bot with [@BotFather](https://t.me/BotFather), copy bot token.
2. Clone this repo or download the code archive.
3. Copy `.env.example` to `.env` and edit it, follow the comments.
4. If you're not using polling, set up a reverse proxy so your webhook URL would actually be available via HTTPS.

#### With docker compose (recommended)
5. Run `docker compose up -d`.

#### Manually
5. Install node.js 18 (higher versions could work too, untested).
6. Run `npm i`.
7. Run `npm run start`.

## Usage
#### General
1. Send `/start` to the bot, it should answer with an introductory message.
2. Type or paste any info about transactions you had, whether they are expenses or deposits. Almost anything should work, starting from a simple amount you spent or received and ending with complex messages (obviously depends on the capabilities of the model you use). You can also mention multiple transactions in a single message.

#### Notes
 - only text messages are supported at the moment, no attachments of any kind
 - default category and account you set in the .env file should actually exist in Actual Budget, the bot won't create them for you (new payees will be created on the fly though)
 - on the `info` log level, bot outputs all user IDs of all incoming messages to stdout, in case you need a quick way to get them
 - `debug` level could also be useful if you want to track what exactly is being sent to the model and to the app
 - there's a `/health` endpoint that could be used for monitoring

#### Custom Input [experimental]
If you uncomment and set `INPUT_API_KEY` in the `.env` file, you'll be able to send messages from outside of Telegram by sending POST requests to `/input` endpoint. Here's a curl example:
```sh
curl -X POST \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: <YOUR_INPUT_API_KEY>" \
  -d '{"user_id":<YOUR_USER_ID>,"text":"<ANY_TEXT>"}' \
  https://<YOUR_DOMAIN>/input
```
The bot will process the message as if it was sent from Telegram and will send the response back to the user using the provided `user_id`. The user ID must be one of those defined in the `USER_IDS` variable. This was mostly done to circumvent iOS Shortcuts limitations, but could be used for other purposes as well.

## Contributing
Contributions are welcome! Feel free to open an issue or submit a pull request.