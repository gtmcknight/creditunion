/// The /credits tiles' numbers, counted at build (scripts/bins.mjs).
declare module 'virtual:credits-facts' {
  const facts: import('./views/credits').Facts;
  export default facts;
}
