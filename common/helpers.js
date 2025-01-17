const _prettyjson = require('prettyjson');

module.exports = {
    obfuscate,
    validateAndTrimUrl,
    createUpdateObject,
    prettyjson
};

// Helper to output a pretty JSON.
function prettyjson(data) {
    return _prettyjson.render(data, { noColor: true, inlineArrays: true });
}

// Helper to obfuscate sensitive strings.
function obfuscate(value) {
    if (!value) return '';
    if (value.length < 16) return '*'.repeat(value.length);
    return value.substring(0, 4) + '...' + value.substring(value.length - 4);
}

// Checks if a URL has https and trims trailing slashes.
function validateAndTrimUrl(url) {
    if (!url) {
        throw new Error('No URL provided.');
    }
    const trimmedUrl = url.replace(/\/+$/, '');
    try {
        const parsedUrl = new URL(trimmedUrl);
        if (parsedUrl.protocol !== 'https:') {
            throw new Error('URL must start with https://');
        }
        return trimmedUrl;
    } catch (error) {
        throw new Error(`Invalid URL: ${error.message}`);
    }
}

// Creates a telegram update object.
function createUpdateObject(user_id, userName, text) {
    const now = Math.floor(Date.now() / 1000);
    return {
        update_id: now,
        message: {
            message_id: now,
            from: {
                id: user_id,
                is_bot: false,
                first_name: userName
            },
            chat: {
                id: user_id,
                type: 'private'
            },
            date: now,
            text
        }
    };
}