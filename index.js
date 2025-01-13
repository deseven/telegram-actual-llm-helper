require('dotenv').config();
const fs = require('fs');
const express = require('express');
const { Telegraf } = require('telegraf');
const winston = require('winston');
const axios = require('axios');
const OpenAI = require('openai');
const prettyjson = require('prettyjson');
const Actual = require('@actual-app/api');

// -- Config --
const BOT_TOKEN = process.env.BOT_TOKEN;
const USE_POLLING = process.env.USE_POLLING === 'true'; // Ensure boolean
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const PORT = parseInt(process.env.PORT,10) || 5005;
const LOG_LEVEL = process.env.LOG_LEVEL || 'warn';
const USER_IDS = (process.env.USER_IDS || '999999999').split(',').map(id => parseInt(id.trim(), 10));
const INPUT_API_KEY = process.env.INPUT_API_KEY || '';
const INTRO_DEFAULT = `This is a private bot that helps with adding transactions to Actual Budget by using ChatGPT or other LLMs.

You can set up your own instance, more info here:
https://github.com/deseven/telegram-actual-llm-helper

Your User ID is %USER_ID%.`;
const INTRO = `Hello! Send me any information about a transaction and I'll try to process it!`;

// -- Actual --
const ACTUAL_API_ENDPOINT = process.env.ACTUAL_API_ENDPOINT;
const ACTUAL_PASSWORD = process.env.ACTUAL_PASSWORD;
const ACTUAL_SYNC_ID = process.env.ACTUAL_SYNC_ID;
const ACTUAL_DATA_DIR = process.env.ACTUAL_DATA_DIR || '/app/data';
const ACTUAL_CURRENCY = process.env.ACTUAL_CURRENCY || 'EUR';
const ACTUAL_DEFAULT_ACCOUNT = process.env.ACTUAL_DEFAULT_ACCOUNT || 'Cash';
const ACTUAL_DEFAULT_CATEGORY = process.env.ACTUAL_DEFAULT_CATEGORY || 'Food';

// -- ChatGPT --
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_API_ENDPOINT = process.env.OPENAI_API_ENDPOINT || 'https://api.openai.com/v1';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const OPENAI_TEMPERATURE = parseFloat(process.env.OPENAI_TEMPERATURE) || 0.2;
const OPENAI_PROMPT = `You are a helpful AI that assists in adding transactions to personal finance software.

Today is ${new Date().toISOString().split('T')[0]}.

You will receive a message from a user containing one or more potential transactions. For each transaction, extract:
- date (optional; if provided, use YYYY-MM-DD format; otherwise leave empty)
- account (required; if not mentioned and cannot be assumed from context, use "${ACTUAL_DEFAULT_ACCOUNT}")
- category (required; if not mentioned and cannot be assumed from context, use "${ACTUAL_DEFAULT_CATEGORY}")
- payee (optional; if not mentioned, leave empty)
- amount (required, numeric, positive or negative; if absent, skip that transaction)
- currency (optional; if not mentioned, default to "${ACTUAL_CURRENCY}")
- notes (optional; a note about that transaction if there is additional context not fit for other fields)

Use these lists to match accounts, categories, and payees:
- Possible accounts: %ACCOUNTS_LIST%
- Possible categories: %CATEGORY_LIST%
- Current payees: %PAYEE_LIST%

Matching rules:
1. If the user's text closely resembles an item in the list, use that.
2. If no match is found for account/category, use the defaults.
3. If no match is found for payee, treat it as a new payee.

Additional rules:
- The output should be a JSON array with one object per transaction.
- If the user mentions an amount without specifying sign, you can infer from context or assume negative.
- If you cannot extract an amount, skip that transaction.
- If there are no valid transactions, return an empty array.

**Important**: Output must be valid JSON only—no extra text, explanations, or markdown.

Example output with no transactions:
[]

Example output with one transaction:
[
  {
    "date": "2023-01-01",
    "account": "Cash",
    "category": "Food",
    "amount": -12.34,
    "currency": "EUR",
    "notes": "Groceries for the week"
  }
]

Example output with multiple transactions:
[
  {
    "date": "2023-01-01",
    "account": "Cash",
    "category": "Food",
    "payee": "Supermarket",
    "amount": -12.34,
    "currency": "EUR",
    "notes": "Groceries for the week"
  },
  {
    "account": "Cash",
    "category": "Restaurants",
    "payee": "Restaurant",
    "amount": -56.78,
    "currency": "USD"
  },
  {
    "account": "Cash",
    "category": "Income",
    "amount": 100.00,
    "currency": "EUR",
    "notes": "Debt from John"
  }
]`;

// -- Winston Logger --
const logger = winston.createLogger({
  level: LOG_LEVEL,
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.align(),
    winston.format.printf(({ timestamp, level, message }) => `[${timestamp}] [${level}]: ${message}`)
  ),
  transports: [new winston.transports.Console()]
});

// Override console methods to use Winston logger
console.log = (...args) => logger.debug(args.join(' '));
console.info = (...args) => logger.info(args.join(' '));
console.warn = (...args) => logger.warn(args.join(' '));
console.error = (...args) => logger.error(args.join(' '));
console.debug = (...args) => logger.debug(args.join(' '));

logger.info('Bot is starting up...');

// -- Display settings on startup --
const envSettings = {
  BOT_TOKEN: obfuscate(BOT_TOKEN),
  USE_POLLING,
  WEBHOOK_URL,
  PORT,
  LOG_LEVEL,
  USER_IDS,
  INPUT_API_KEY: obfuscate(INPUT_API_KEY),
  OPENAI_API_KEY: obfuscate(OPENAI_API_KEY),
  OPENAI_API_ENDPOINT,
  OPENAI_MODEL,
  OPENAI_TEMPERATURE,
  ACTUAL_API_ENDPOINT,
  ACTUAL_PASSWORD: obfuscate(ACTUAL_PASSWORD),
  ACTUAL_SYNC_ID,
  ACTUAL_CURRENCY,
  ACTUAL_DEFAULT_ACCOUNT,
  ACTUAL_DEFAULT_CATEGORY,
  ACTUAL_DATA_DIR
};
logger.info(`=== Startup Settings ===\n${prettyjson.render(envSettings,{noColor: true})}`);

if (INPUT_API_KEY.length < 16) {
  logger.warn('For security reasons INPUT_API_KEY must be at least 16 characters long, /input will be disabled.');
}

// Helper to obfuscate sensitive strings.
function obfuscate(value) {
  if (!value) return '';
  if (value.length <= 16) return '*'.repeat(value.length);
  return value.substring(0, 4) + '...' + value.substring(value.length - 4);
}

// -- Initialize the Telegraf Bot --
const bot = new Telegraf(BOT_TOKEN);

// -- Initialize Actual API --
async function initActual() {
  try {
    if (!fs.existsSync(ACTUAL_DATA_DIR)) {
      logger.info(`Creating data directory: ${ACTUAL_DATA_DIR}`);
      fs.mkdirSync(ACTUAL_DATA_DIR, { recursive: true });
    }

    await Actual.init({
      dataDir: ACTUAL_DATA_DIR,
      serverURL: ACTUAL_API_ENDPOINT,
      password: ACTUAL_PASSWORD,
    });

    logger.debug('Downloading budget...');
    await Actual.downloadBudget(ACTUAL_SYNC_ID);
    logger.info('Successfully connected to Actual Budget.');
  } catch (error) {
    logger.error('Error connecting to Actual Budget:', error);
  }
}

// -- Currency Conversion --
async function convertCurrency(amount, fromCurrency, toCurrency, apiDate) {
  if (fromCurrency.toLowerCase() === toCurrency.toLowerCase()) {
    return parseFloat(amount.toFixed(2));
  }

  const apiUrl = `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${apiDate}/v1/currencies/${fromCurrency.toLowerCase()}.json`;
  logger.debug(`Fetching currency conversion from ${apiUrl}`);
  try {
    const response = await axios.get(apiUrl);
    const rates = response.data[fromCurrency.toLowerCase()];
    if (!rates || !rates[toCurrency.toLowerCase()]) {
      throw new Error(`Currency conversion rate not found for ${fromCurrency} to ${toCurrency}`);
    }
    const convertedAmount = amount * rates[toCurrency.toLowerCase()];
    return parseFloat(convertedAmount.toFixed(2));
  } catch (error) {
    logger.error('Error converting currency:', error);
    throw new Error('Failed to convert currency');
  }
}

// -- Unified Message Handler --
bot.on('message', async (ctx) => {
  const userId = ctx.from?.id;
  const chatType = ctx.chat?.type;
  const messageText = ctx.message.text || ctx.message.caption;

  logger.info(`Incoming message from user: ${userId}, chat type: ${chatType}`);

  if (messageText) {
    const trimmedText = messageText.trim();

    // Handle /start or /help command
    if (chatType === 'private') {
      if (USER_IDS.includes(userId)) {
        if (trimmedText == '/start' || trimmedText == '/help') {
          logger.info(`Received "${trimmedText}" from user ${userId} in private chat.`);
          logger.debug(`Sending intro message to user ${userId}.`);
          return ctx.reply(INTRO.replace('%USER_ID%', userId));
        } else {
          await Actual.sync();
          const categories = await Actual.getCategories();
          const accounts = await Actual.getAccounts();
          const payees = await Actual.getPayees();

          const prompt = OPENAI_PROMPT
            .replace('%ACCOUNTS_LIST%', accounts.map(acc => acc.name).join(', '))
            .replace('%CATEGORY_LIST%', categories.map(cat => cat.name).join(', '))
            .replace('%PAYEE_LIST%', payees.map(payee => payee.name).join(', '));

          // 1) CALL THE LLM AND PARSE ITS RESPONSE
          let parsedResponse = null;
          try {
            const openai = new OpenAI({
              apiKey: OPENAI_API_KEY,
              baseURL: OPENAI_API_ENDPOINT,
            });

            logger.debug('=== LLM Request Details ===');
            logger.debug('System Prompt:\n' + prompt);
            logger.debug(`User Message: ${trimmedText}`);

            const response = await openai.chat.completions.create({
              model: OPENAI_MODEL,
              messages: [
                { role: 'system', content: prompt },
                { role: 'user', content: trimmedText },
              ],
              temperature: OPENAI_TEMPERATURE,
            });

            // Remove possible Markdown fences
            const jsonResponse = response.choices[0].message.content
              .replace(/```(?:json)?\n?|\n?```/g, '')
              .trim();

            logger.debug('=== LLM Response ===');
            logger.debug(jsonResponse);

            parsedResponse = JSON.parse(jsonResponse);

            if (!Array.isArray(parsedResponse)) {
              throw new Error('LLM response is not an array');
            }

            if (parsedResponse.length === 0) {
              return ctx.reply('Failed to find any information to create transactions. Try again?');
            }
          } catch (err) {
            logger.error('Error obtaining/parsing LLM response:', err);
            return ctx.reply('Sorry, I received an invalid or empty response from the LLM. Check the bot logs.');
          }

          // 2) CREATE TRANSACTIONS IN ACTUAL
          try {
            let replyMessage = '*[TRANSACTIONS]*\n';
            let txInfo = {};
            const transactions = await Promise.all(parsedResponse.map(async (tx) => {
              const account = accounts.find(acc => acc.name === tx.account)
                || accounts.find(acc => acc.name === ACTUAL_DEFAULT_ACCOUNT);

              const category = categories.find(cat => cat.name === tx.category);
              const payee = payees.find(p => p.name === tx.payee);

              if (!account) {
                throw new Error(`Invalid account specified: "${tx.account}"`);
              }
              if (!category) {
                throw new Error(`Invalid category specified: "${tx.category}"`);
              }

              let date = tx.date || new Date().toISOString().split('T')[0];
              let apiDate = date;
              let amount = tx.amount;

              // If date is today, currency API may not have today's data yet due to timezone differences
              if (date === new Date().toISOString().split('T')[0]) {
                apiDate = 'latest';
              }

              if (tx.currency && tx.currency.toLowerCase() !== ACTUAL_CURRENCY.toLowerCase()) {
                amount = await convertCurrency(tx.amount, tx.currency, ACTUAL_CURRENCY, apiDate);
              }

              // Provide human-readable output of processed transaction data
              replyMessage += '```\n';
              let humanAmount = `${tx.amount} ${tx.currency}`;
              let humanConvertedAmount = '';
              if (tx.currency && tx.currency.toLowerCase() !== ACTUAL_CURRENCY.toLowerCase()) {
                humanConvertedAmount = `${amount} ${ACTUAL_CURRENCY}`;
              }

              txInfo = {
                date,
                account: account.name,
                category: category.name,
                ...(humanAmount && { amount: humanAmount }),
                ...(humanConvertedAmount && { converted: humanConvertedAmount }),
                ...(tx.payee && { payee: tx.payee }),
                ...(tx.notes && { notes: tx.notes })
              };
              replyMessage += prettyjson.render(txInfo,{noColor: true});
              replyMessage += '```\n';

              amount = parseFloat((amount * 100).toFixed(2)); // Convert to cents
              return {
                account: account.id,
                date,
                amount,
                payee_name: tx.payee || null,
                category: category.id,
                notes: `[TGBOT] ${tx.notes || ''}`,
              };
            }));

            // Group transactions by account
            const transactionsByAccount = transactions.reduce((acc, tx) => {
              if (!acc[tx.account]) {
                acc[tx.account] = [];
              }
              acc[tx.account].push(tx);
              return acc;
            }, {});

            const results = [];

            for (const [accountId, accountTxs] of Object.entries(transactionsByAccount)) {
              const transactionsText = accountTxs.map(tx =>
                `Account: ${tx.account}, Date: ${tx.date}, Amount: ${tx.amount}, Payee: ${tx.payee_name}, Category: ${tx.category}, Notes: ${tx.notes}`
              ).join('\n');
              logger.info(`Importing transactions for account ${accountId}:\n${transactionsText}`);

              const result = await Actual.importTransactions(accountId, accountTxs);
              results.push(result);
            }

            replyMessage += '\n*[ACTUAL]*\n';
            const totalAdded = results.reduce((sum, r) => sum + (r.added?.length || 0), 0);
            const totalUpdated = results.reduce((sum, r) => sum + (r.updated?.length || 0), 0);
            const totalErrors = results.reduce((sum, r) => sum + (r.errors?.length || 0), 0);

            if (totalAdded > 0) replyMessage += `- Added: ${totalAdded}\n`;
            if (totalUpdated > 0) replyMessage += `- Updated: ${totalUpdated}\n`;
            if (totalErrors > 0) replyMessage += `- Errors: ${totalErrors}\n`;
            if (totalAdded === 0 && totalUpdated === 0 && totalErrors === 0) {
              replyMessage += 'no changes';
            } else {
              await Actual.sync();
            }

            return ctx.reply(replyMessage, { parse_mode: 'Markdown' });

          } catch (err) {
            logger.error('Error creating transactions in Actual Budget:', err);

            if (err.message && err.message.includes('convert currency')) {
              return ctx.reply('Sorry, there was an error converting the currency. Check the bot logs.');
            }
            return ctx.reply('Sorry, I encountered an error creating the transaction(s). Check the bot logs.');
          }
        }
      } else {
        return ctx.reply(INTRO_DEFAULT);
      }
    }
  }
});

// -- Error handling --
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception thrown:', err);
  process.exit(2);
});

bot.catch((err, ctx) => {
  logger.error('Global Telegraf error:', err);
});

// Create Express app
const app = express();
app.use(express.json());

app.post('/webhook', (req, res) => {
  try {
    bot.handleUpdate(req.body);
    res.sendStatus(200);
  } catch (error) {
    logger.error('Error handling update:', error);
    res.sendStatus(500);
  }
});

// EXPERIMENTAL: API endpoint for custom input outside Telegram
app.post('/input', (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];

    if (!apiKey || apiKey !== INPUT_API_KEY || !INPUT_API_KEY || INPUT_API_KEY.length < 16) {
      return res.status(401).send('Unauthorized');
    }

    const { user_id, text } = req.body;
    const now = Math.floor(Date.now() / 1000);
    const update = {
      update_id: now,
      message: {
        message_id: now,
        from: {
          id: user_id,
          is_bot: false,
          first_name: 'APIUser'
        },
        chat: {
          id: user_id,
          type: 'private'
        },
        date: now,
        text
      }
    };

    if (USER_IDS.includes(user_id)) {
      bot.handleUpdate(update);
      return res.json({ status: 'OK' });
    } else {
      return res.status(403).send('Forbidden');
    }
    
  } catch (error) {
    logger.error('Error handling manual message:', error);
    return res.status(500).json({ error: 'Failed to handle message' });
  }
});

app.get('/health', (req, res) => {
  res.send('OK');
});

// Start the server
app.listen(PORT, () => {
  startBot().catch(err => {
    logger.error('Error starting bot:', err);
    process.exit(3);
  });
});

async function startBot() {
  await initActual();

  if (USE_POLLING) {
    logger.debug('Attempting to delete any existing webhook before polling...');
    try {
      await bot.telegram.deleteWebhook({ drop_pending_updates: true });
      logger.debug('Webhook deleted successfully');
    } catch (err) {
      logger.warn(`deleteWebhook failed: ${err}`);
    }

    try {
      bot.launch();
      logger.debug('Polling enabled!');
    } catch (err) {
      logger.error('Error launching bot with polling:', err);
      process.exit(3);
    }
  } else {
    logger.debug('Setting webhook...');
    try {
      await bot.telegram.setWebhook(`${WEBHOOK_URL}/webhook`);
      logger.debug(`Webhook set: ${WEBHOOK_URL}/webhook`);
    } catch (err) {
      logger.error('Error setting webhook:', err);
      process.exit(3);
    }
  }

  logger.info('Bot started successfully!');
}