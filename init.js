require('dotenv').config();
const fs = require('fs');
const winston = require('winston');
const { Telegraf } = require('telegraf')
const Actual = require('@actual-app/api');
const prettyjson = require('prettyjson');
const express = require('express');
const axios = require('axios');
const helpers = require('./helpers');

// -- Winston Logger --
const LOG_LEVEL = process.env.LOG_LEVEL || 'warn';
const logger = winston.createLogger({
    level: LOG_LEVEL,
    format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.align(),
        winston.format.printf(({ timestamp, level, message }) => `[${timestamp}] [${level}]: ${message}`)
    ),
    transports: [
        new winston.transports.Console()
    ]
});

// Override native console methods so they use Winston
console.log = (...args) => logger.debug(args.join(' '));
console.info = (...args) => logger.info(args.join(' '));
console.warn = (...args) => logger.warn(args.join(' '));
console.error = (...args) => logger.error(args.join(' '));
console.debug = (...args) => logger.debug(args.join(' '));

// -- Configuration Values --

// Telegram Bot
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
    logger.error('Missing BOT_TOKEN. Provide a correct token in the .env file.');
    process.exit(1);
}

const USE_POLLING = process.env.USE_POLLING === 'true';

// Validate BASE_URL only if not using polling
let BASE_URL = '';
if (!USE_POLLING) {
    try {
        BASE_URL = helpers.validateAndTrimUrl(process.env.BASE_URL);
    } catch (error) {
        logger.error('Invalid or missing BASE_URL. Provide a correct URL in the .env file or set USE_POLLING to true.');
        process.exit(1);
    }
}

// Express
const PORT = parseInt(process.env.PORT, 10) || 5007;

// User IDs
const USER_IDS = (process.env.USER_IDS || '999999999').split(',').map(id => parseInt(id.trim(), 10));
const INPUT_API_KEY = process.env.INPUT_API_KEY || '';

// Intro texts
const INTRO_DEFAULT = `This is a private bot that helps with adding transactions to Actual Budget by using ChatGPT or other LLMs.

You can set up your own instance, more info here:
https://github.com/deseven/telegram-actual-llm-helper

Your User ID is %USER_ID%.`;
const INTRO = `Hello! Send me any information about a transaction and I'll try to process it!`;

// Actual
const ACTUAL_API_ENDPOINT = process.env.ACTUAL_API_ENDPOINT;
const ACTUAL_PASSWORD = process.env.ACTUAL_PASSWORD;
const ACTUAL_SYNC_ID = process.env.ACTUAL_SYNC_ID;
const ACTUAL_DATA_DIR = process.env.ACTUAL_DATA_DIR || '/app/data';
const ACTUAL_CURRENCY = process.env.ACTUAL_CURRENCY || 'EUR';
const ACTUAL_DEFAULT_ACCOUNT = process.env.ACTUAL_DEFAULT_ACCOUNT || 'Cash';
const ACTUAL_DEFAULT_CATEGORY = process.env.ACTUAL_DEFAULT_CATEGORY || 'Food';
const ACTUAL_NOTE_PREFIX = process.env.ACTUAL_NOTE_PREFIX || '🤖';

if (!ACTUAL_API_ENDPOINT || !ACTUAL_PASSWORD || !ACTUAL_SYNC_ID) {
    logger.error('Missing Actual API configuration. Exiting...');
    process.exit(1);
}

// OpenAI
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_API_ENDPOINT = process.env.OPENAI_API_ENDPOINT || 'https://api.openai.com/v1';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const OPENAI_TEMPERATURE = parseFloat(process.env.OPENAI_TEMPERATURE) || 0.2;

// Loading custom prompt if available
let OPENAI_PROMPT_PATH = './default.prompt';
try {
    const customPath = './custom.prompt';
    if (fs.existsSync(customPath) && fs.statSync(customPath).size > 0) {
        OPENAI_PROMPT_PATH = customPath;
    }
} catch (error) {
    logger.error('Error checking for custom prompt file:', error);
    process.exit(1);
}

let OPENAI_PROMPT = '';
try {
    OPENAI_PROMPT = fs.readFileSync(OPENAI_PROMPT_PATH, 'utf8').trim();
} catch (err) {
    logger.error(`Failed to load prompt from ${OPENAI_PROMPT_PATH}.`, err);
    process.exit(1);
}

if (INPUT_API_KEY.length < 16) {
    logger.warn('For security reasons INPUT_API_KEY must be at least 16 characters long, /input endpoint will be disabled.');
}

// -- Display settings on startup --
const envSettings = {
    BOT_TOKEN: helpers.obfuscate(BOT_TOKEN),
    USE_POLLING,
    BASE_URL,
    PORT,
    LOG_LEVEL,
    USER_IDS,
    INPUT_API_KEY: helpers.obfuscate(INPUT_API_KEY),
    OPENAI_API_KEY: helpers.obfuscate(OPENAI_API_KEY),
    OPENAI_API_ENDPOINT,
    OPENAI_MODEL,
    OPENAI_TEMPERATURE,
    OPENAI_PROMPT_PATH,
    ACTUAL_API_ENDPOINT,
    ACTUAL_PASSWORD: helpers.obfuscate(ACTUAL_PASSWORD),
    ACTUAL_SYNC_ID,
    ACTUAL_CURRENCY,
    ACTUAL_DEFAULT_ACCOUNT,
    ACTUAL_DEFAULT_CATEGORY,
    ACTUAL_DATA_DIR,
    ACTUAL_NOTE_PREFIX
};
logger.info(`=== Startup Settings ===\n${prettyjson.render(envSettings, { noColor: true })}`);

// -- Initialize Express App --
function InitApp() {
    let App = express();
    App.use(express.json());
    return App;
}

// -- Initialize Bot --
function InitBot() {
    try {
        const Bot = new Telegraf(BOT_TOKEN);
        Bot.catch((err, ctx) => {
            logger.error('Global Telegraf error:', err);
        });
        return Bot;
    } catch (error) {
        logger.error(`Failed to initialize Telegraf: ${error.message}`);
        process.exit(1);
    }
}

// -- Launch Bot --
async function LaunchBot(Bot) {
    if (USE_POLLING) {
        logger.debug('Attempting to delete any existing webhook before polling...');
        try {
            await Bot.telegram.deleteWebhook({ drop_pending_updates: true });
            logger.debug('Webhook deleted successfully.');
        } catch (err) {
            logger.warn(`deleteWebhook failed: ${err}`);
        }

        try {
            Bot.launch();
            logger.debug('Polling enabled!');
        } catch (err) {
            logger.error('Error launching bot with polling:', err);
            process.exit(1);
        }
    } else {
        logger.debug('Setting webhook...');
        try {
            await Bot.telegram.setWebhook(`${BASE_URL}/webhook`);
            logger.debug(`Webhook set: ${BASE_URL}/webhook`);
        } catch (err) {
            logger.error('Error setting webhook:', err);
            process.exit(1);
        }
    }
    logger.info('Successfully connected to Telegram.');
}

// -- Initialize Actual --
function InitActual() {
    try {
        if (!fs.existsSync(ACTUAL_DATA_DIR)) {
            logger.info(`Creating data directory: ${ACTUAL_DATA_DIR}`);
            fs.mkdirSync(ACTUAL_DATA_DIR, { recursive: true });
        }

        Actual.init({
            dataDir: ACTUAL_DATA_DIR,
            serverURL: ACTUAL_API_ENDPOINT,
            password: ACTUAL_PASSWORD,
        }).then(() => {
            logger.debug('Downloading budget...');
            return Actual.downloadBudget(ACTUAL_SYNC_ID);
        }).then(() => {
            logger.debug('Checking default account and category...');
            return Promise.all([Actual.getCategories(), Actual.getAccounts()]);
        }).then(([categories, accounts]) => {
            let account = accounts.find(acc => acc.name === ACTUAL_DEFAULT_ACCOUNT);
            let category = categories.find(cat => cat.name === ACTUAL_DEFAULT_CATEGORY);
            if (!account || !category) {
                logger.error('Could not find default account or category, check your configuration.');
                process.exit(1);
            }
            logger.info('Successfully connected to Actual Budget.');
        }).catch(error => {
            logger.error('Error connecting to Actual Budget:', error);
            process.exit(1);
        });

        return Actual;
    } catch (error) {
        logger.error('Error connecting to Actual Budget:', error);
        process.exit(1);
    }
}

// -- Error handling --
process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
    process.exit(1);
});

process.on('uncaughtException', (err) => {
    logger.error('Uncaught Exception thrown:', err);
    process.exit(1);
});

// -- Currency Conversion --
async function convertCurrency(amount, fromCurrency, toCurrency, apiDate, rate = undefined) {
    if (fromCurrency.toLowerCase() === toCurrency.toLowerCase()) {
        return parseFloat(amount.toFixed(2));
    }

    if (rate !== undefined) {
        logger.debug(`Using provided rate: ${rate} for conversion from ${fromCurrency} to ${toCurrency}`);
        const convertedAmount = amount * rate;
        return parseFloat(convertedAmount.toFixed(2));
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

module.exports = {
    InitApp,
    InitBot,
    LaunchBot,
    InitActual,
    prettyjson,
    convertCurrency,
    helpers,
    logger,
    config: {
        LOG_LEVEL,
        BOT_TOKEN,
        USE_POLLING,
        BASE_URL,
        PORT,
        USER_IDS,
        INPUT_API_KEY,
        INTRO_DEFAULT,
        INTRO,
        ACTUAL_API_ENDPOINT,
        ACTUAL_PASSWORD,
        ACTUAL_SYNC_ID,
        ACTUAL_DATA_DIR,
        ACTUAL_CURRENCY,
        ACTUAL_DEFAULT_ACCOUNT,
        ACTUAL_DEFAULT_CATEGORY,
        ACTUAL_NOTE_PREFIX,
        OPENAI_API_KEY,
        OPENAI_API_ENDPOINT,
        OPENAI_MODEL,
        OPENAI_TEMPERATURE,
        OPENAI_PROMPT_PATH,
        OPENAI_PROMPT,
    },
};