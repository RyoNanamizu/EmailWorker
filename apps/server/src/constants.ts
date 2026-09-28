export const BEARER_TOKEN_ENV = "BEARER_TOKEN";
export const LISTEN_HOST_ENV = "LISTEN_HOST";
export const LISTEN_PORT_ENV = "LISTEN_PORT";

export const DEFAULT_LISTEN_HOST = "0.0.0.0";
export const DEFAULT_LISTEN_PORT = 8080;
export const DEFAULT_MAILDIR_PATH = "maildir";

export const PUSH_PATH_PREFIX = "/push/";
export const BEARER_AUTH_SCHEME = "Bearer";
export const BEARER_AUTH_PREFIX = `${BEARER_AUTH_SCHEME} `;
export const MAIL_MEDIA_TYPE = "message/rfc822";

export const MAIL_RECEIVED_AT_HEADER = "x-mail-received-at";
export const MAIL_FROM_HEADER = "x-mail-from";
export const MAIL_TO_HEADER = "x-mail-to";

export const MAILDIR_DIRECTORIES = ["tmp", "new", "cur"] as const;
export const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/i;
