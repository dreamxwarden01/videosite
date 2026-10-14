'use strict';
const express = require('express');
const { EVENT_FORM_LIMIT, EVENT_TOKEN_LIMIT } = require('../lib/ssoRoleProtocol');
const eventFormParser = () => express.urlencoded({ extended: false, limit: EVENT_FORM_LIMIT, parameterLimit: 10 });
function readEventToken(body) {
    const token = body?.event_token;
    return typeof token === 'string' && token.length > 0 && token.length <= EVENT_TOKEN_LIMIT ? token : null;
}
module.exports = { eventFormParser, readEventToken };
