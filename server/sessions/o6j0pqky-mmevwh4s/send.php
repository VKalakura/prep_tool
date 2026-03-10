<?php
require_once '/var/www/keitaro/lander/include-thanks-page/global.php';
sendToSpread(
    getParam(CSRF),
    [
        SUB_ID        => getParam(SUB_ID),
        EMAIL         => getParam(EMAIL),
        PHONE         => getParam(PHONE),
        FIRST_NAME    => getParam(FIRST_NAME),
        LAST_NAME     => getParam(LAST_NAME),
        PASSWORD      => getParam(PASSWORD, generatePassword()),
        COUNTRY_CODE  => getParam('', 'ES'),
        TOWN          => getParam(TOWN, 'NY'),
        GENDER        => getParam(GENDER, 'male'),
        CURRENCY      => getParam(CURRENCY, 'USD'),
        ACCOUNT       => getParam(ACCOUNT, 'Facebook'),
        DOMAIN        => getDomain(),
        SOURCE_TYPE   => 'FACEBOOK',
        REMOTE_IP     => getRealIpAddr(),
        USER_AGENT    => getUserAgent(),
        LANGUAGE_CODE => 'FR',
        CREO          => getParam(CREO),
        SEARCH_ID     => getParam(SEARCH_ID),
        OFFER_NAME    => 'Quantum aasdasdsd',
        OFFER_URL     => '',
    ]
);
