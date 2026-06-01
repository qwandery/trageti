const ANSI_ESCAPE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const UNSAFE_CONTROL = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\x80-\x9F]/g;

export function sanitizeForTerminal(value: string): string {
  return value
    .replace(ANSI_ESCAPE, '')
    .replace(UNSAFE_CONTROL, '')
    .replaceAll('Ã¢â‚¬â€', '-')
    .replaceAll('Ã¢â‚¬â€œ', '-')
    .replaceAll('Ã¢â‚¬â„¢', "'")
    .replaceAll('Ã¢â‚¬Å“', '"')
    .replaceAll('Ã¢â‚¬ï¿½', '"')
    .replaceAll('Ã¢â€ â€™', '->')
    .replaceAll('â€”', '-')
    .replaceAll('â€“', '-')
    .replaceAll('â€™', "'")
    .replaceAll('â€œ', '"')
    .replaceAll('â€', '"')
    .replaceAll('â†’', '->')
    .replaceAll('â€¦', '...');
}
