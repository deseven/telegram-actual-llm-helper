require('dotenv').config();
const fs = require('fs');
const express = require('express');
const { Telegraf } = require('telegraf');
const winston = require('winston');
const axios = require('axios');
const OpenAI = require('openai');
const prettyjson = require('prettyjson');
const Actual = require('@actual-app/api');

// -- Environment Variables --
const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const PORT = parseInt(process.env.PORT,10) || 5005;
const LOG_LEVEL = process.env.LOG_LEVEL || 'warn';
const USER_IDS = (process.env.USER_IDS || '999999999').split(',').map(id => parseInt(id.trim(), 10));
const INTRO_DEFAULT = `Hello! This is a private bot that helps with adding spendings to Actual Budget by using ChatGPT or other LLMs.

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
const OPENAI_PROMPT = `You are a helpful AI that helps adding transactions to personal finance software.
You will receive a message from a user and you need to extract the following information from it:
 - date (optional, default is empty, format YYYY-MM-DD)
 - account (required, default is "${ACTUAL_DEFAULT_ACCOUNT}")
 - category (required, default is "${ACTUAL_DEFAULT_CATEGORY}")
 - payee (optional, default is empty)
 - amount (required, could be positive or negative, depending on the context)
 - currency (optional, default is "${ACTUAL_CURRENCY}")
 - notes (optional, a summary of user provided details, if any)

Possible accounts: %ACCOUNTS_LIST%

Possible categories: %CATEGORY_LIST%

Current payees: %PAYEE_LIST%

There could be multiple entries, you need to process each and return a JSON array with the extracted information, for example:
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
]

Accounts and categories should be picked from the lists provided, payee could be picked from the list or it could be a new one.
If you can't extract any amounts, return an empty array. Never add any comments or explanations, return only JSON without any markdown formatting.`;

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
  WEBHOOK_URL,
  PORT,
  LOG_LEVEL,
  USER_IDS,
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

// Helper to obfuscate sensitive strings.
function obfuscate(value) {
  if (!value) return ''; // Return empty for missing/undefined
  // Keep the first few characters and last few characters visible
  // (adjust to your preference).
  if (value.length <= 16) return '*'.repeat(value.length);
  return value.substring(0, 4) + '...' + value.substring(value.length - 4);
}

// -- Initialize the Telegraf Bot --
const bot = new Telegraf(BOT_TOKEN);

// -- Initialize Actual API --
async function initActual() {
  try {
    // Ensure the data directory exists
    if (!fs.existsSync(ACTUAL_DATA_DIR)) {
      logger.info(`Creating data directory: ${ACTUAL_DATA_DIR}`);
      fs.mkdirSync(ACTUAL_DATA_DIR, { recursive: true });
    }

    // Initialize Actual API
    await Actual.init({
      dataDir: ACTUAL_DATA_DIR,
      serverURL: ACTUAL_API_ENDPOINT,
      password: ACTUAL_PASSWORD,
    });

    // Download the budget
    await Actual.downloadBudget(ACTUAL_SYNC_ID);
    logger.info('Successfully connected to Actual Budget.');
  } catch (error) {
    logger.error('Error connecting to Actual Budget:', error);
  }
}

// -- Currency Conversion --
async function convertCurrency(amount, fromCurrency, toCurrency, apiDate) {
  if (fromCurrency.toLowerCase() === toCurrency.toLowerCase()) {
    return parseFloat(amount.toFixed(2)); // Round to 2 decimal places
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
    return parseFloat(convertedAmount.toFixed(2)); // Round to 2 decimal places
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
          try {
            const openai = new OpenAI({
              apiKey: OPENAI_API_KEY,
              baseURL: OPENAI_API_ENDPOINT,
            });

            // Prepare the prompt with actual data
            const prompt = OPENAI_PROMPT
              .replace('%ACCOUNTS_LIST%', accounts.map(acc => acc.name).join(', '))
              .replace('%CATEGORY_LIST%', categories.map(cat => cat.name).join(', '))
              .replace('%PAYEE_LIST%', payees.map(payee => payee.name).join(', '));

            // Log debug information
            logger.debug('=== OpenAI Request Details ===');
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

            // remove markdown around, just in case
            const jsonResponse = response.choices[0].message.content.replace(/```(?:json)?\n?|\n?```/g, '').trim();

            // Log the full response
            logger.debug('=== OpenAI Response ===');
            logger.debug(jsonResponse);

            // Validate JSON response
            try {
              const parsedResponse = JSON.parse(jsonResponse);
              if (!Array.isArray(parsedResponse)) {
                throw new Error('Response is not an array');
              }

              if (parsedResponse.length === 0) {
                return ctx.reply('Failed to find any information to create transactions. Try again?');
              }

              // Prepare transactions for Actual
              const transactions = await Promise.all(parsedResponse.map(async (tx) => {
                const account = accounts.find(acc => acc.name === tx.account) || accounts.find(acc => acc.name === ACTUAL_DEFAULT_ACCOUNT);
                const category = categories.find(cat => cat.name === tx.category);
                const payee = payees.find(p => p.name === tx.payee);

                if (!account || !category) {
                  throw new Error('Invalid account or category');
                }

                // Convert currency if necessary
                let date = tx.date || new Date().toISOString().split('T')[0];
                let apiDate = date;
                let amount = tx.amount;
                if (date === new Date().toISOString().split('T')[0]) {
                  apiDate = 'latest'; // due to tz differences, several hours every day the current day endpoint is not available
                }
                if (tx.currency && tx.currency.toLowerCase() !== ACTUAL_CURRENCY.toLowerCase()) {
                  amount = await convertCurrency(tx.amount, tx.currency, ACTUAL_CURRENCY, apiDate);
                }

                amount = amount * 100; // Convert to cents
                amount = parseFloat(amount.toFixed(2));

                return {
                  account: account.id,
                  date: date,
                  amount: amount,
                  payee_name: tx.payee ? tx.payee : null,
                  category: category.id,
                  notes: `[TGBOT] ${tx.notes}`,
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

              // Import transactions to Actual, one account at a time
              const results = [];
              for (const [accountId, accountTransactions] of Object.entries(transactionsByAccount)) {
                // Log transactions as text for debugging
                const transactionsText = accountTransactions.map(tx =>
                  `Account: ${tx.account}, Date: ${tx.date}, Amount: ${tx.amount}, Payee: ${tx.payee_name}, Category: ${tx.category}, Notes: ${tx.notes}`
                ).join('\n');
                logger.info(`Importing transactions for account ${accountId}:\n${transactionsText}`);

                const result = await Actual.importTransactions(accountId, accountTransactions);
                results.push(result);
              }

              // Summarize the results
              let replyMessage = 'Transactions processed:\n';
              const totalAdded = results.reduce((sum, result) => sum + (result.added?.length || 0), 0);
              const totalUpdated = results.reduce((sum, result) => sum + (result.updated?.length || 0), 0);
              const totalErrors = results.reduce((sum, result) => sum + (result.errors?.length || 0), 0);

              if (totalAdded > 0) {
                replyMessage += `- Added: ${totalAdded}\n`;
              }
              if (totalUpdated > 0) {
                replyMessage += `- Updated: ${totalUpdated}\n`;
              }
              if (totalErrors > 0) {
                replyMessage += `- Errors: ${totalErrors}\n`;
              }
              if (totalAdded === 0 && totalUpdated === 0 && totalErrors === 0) {
                replyMessage += 'none';
              } else {
                await Actual.sync();
              }
              return ctx.reply(replyMessage);
            } catch (parseError) {
              logger.error('Error parsing OpenAI response:', parseError);
              return ctx.reply('Sorry, I received an invalid response from the AI. Check the bot logs.');
            }
          } catch (error) {
            logger.error('Error processing OpenAI request:', error);
            if (error.response) {
              logger.debug('OpenAI API Error Details:', {
                status: error.response.status,
                data: error.response.data
              });
            }
            return ctx.reply('Sorry, I encountered an error processing your request. Check the bot logs.');
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

// -- Setup Express Webhook --
const app = express();
app.use(express.json());

// Set the webhook on startup
bot.telegram.setWebhook(`${WEBHOOK_URL}/webhook`)
  .then(() => {
    logger.debug(`Webhook set: ${WEBHOOK_URL}/webhook`);
  })
  .catch((err) => {
    logger.error('Error setting webhook:', err);
  });

// Define the webhook endpoint
app.post('/webhook', (req, res) => {
  try {
    bot.handleUpdate(req.body);
    res.sendStatus(200);
  } catch (error) {
    logger.error('Error handling update:', error);
    res.sendStatus(500);
  }
});

// Health check
app.get('/health', (req, res) => {
  res.send('OK');
});

// -- Start the server --
app.listen(PORT, () => {
  initActual();
  logger.info(`Bot started successfully!`);
});