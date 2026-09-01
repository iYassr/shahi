/** `/v1/box/<serverId>` or `/v1/phone/<serverId>`. The Worker routes on it; the object re-reads it to learn its role and id. */
export const ROUTE = /^\/v1\/(box|phone)\/([^/]+)$/;
