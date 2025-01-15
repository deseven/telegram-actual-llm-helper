module.exports = {
    obfuscate,
    validateAndTrimUrl
};

// Helper to obfuscate sensitive strings.
function obfuscate(value) {
    if (!value) return '';
    if (value.length <= 16) return '*'.repeat(value.length);
    return value.substring(0, 4) + '...' + value.substring(value.length - 4);
}

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