#!/bin/bash

load_env() {
    if [ -f .env ]; then
        export $(grep -v '^#\|^$' .env | xargs)
    else
        echo ".env file not found"
        exit 1
    fi
}

input_request() {
    local FIRST_USER_ID=$(echo $USER_IDS | cut -d ',' -f 1)
    local TEXT=$(printf "%s\\\\n" "$@")
    TEXT="${TEXT%\\n}"  # Remove the trailing newline
    curl -X POST \
    -H "Content-Type: application/json" \
    -H "X-Api-Key: $INPUT_API_KEY" \
    -d "{\"user_id\":$FIRST_USER_ID,\"text\":\"$TEXT\"}" \
    $BASE_URL/input
    echo ""
}

load_env

# should generate no transactions
input_request "hi what's up"

# should generate one payment with no details
input_request "-1000"

# should generate one payment with details
input_request "bought groceries for 2k in Lidl, paid in cash"

# should generate one deposit with some details and a note
input_request "John returned me 500, he still owes me 1000"

# should generate one deposit with automatic conversion
input_request "got 100 BRL"

# should generate one payment with provided exchange rate
input_request "paid 1k in BRL, exchange rate was 0.51"

# should generate one payment with provided exchange rate and date (generic sms notification from bank, set in the future)
input_request "Kartica: Visa PayWave 1111********1111 Iznos: 4,99 USD  Kurs: 119,9557  Datum: 14.01.2030 21:31 REF: 698170469 Raspolozivo: 1.492,67 RSD Mesto: TEST"

# should generate 5 payments with mixed info
input_request "bought some components on Ali for 500" \
              "also paid bills for 3000 RSD (note: check what remains)" \
              "on my way back lost 10 bucks" \
              "paid for the bus ticket 100" \
              "and for the taxi 200"