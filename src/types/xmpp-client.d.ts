// Ethora.com platform, copyright: Dappros Ltd (c) 2026, all rights reserved
//
// The upstream `@xmpp/client` package ships without TypeScript typings.
// We keep this minimal module declaration so `tsc` can compile and we can still
// use XMPP for synthetic uptime checks.
declare module '@xmpp/client' {
  export const client: any
  export const xml: any
}


