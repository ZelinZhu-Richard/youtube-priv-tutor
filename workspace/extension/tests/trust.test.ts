import { describe, expect, it } from 'vitest';
import { isTrustedSender } from '../src/shared/trust';

const ID = 'abcdefghijklmnopabcdefghijklmnop';
const ext = (path: string) => `chrome-extension://${ID}/${path}`;

describe('isTrustedSender', () => {
  it('accepts the side panel (no tab)', () => {
    expect(isTrustedSender({ id: ID, url: ext('panel/index.html') }, ID)).toBe(true);
  });
  it('accepts Settings and Library, which open in a tab', () => {
    expect(isTrustedSender({ id: ID, url: ext('options/index.html'), tab: { url: ext('options/index.html') } }, ID)).toBe(true);
    expect(isTrustedSender({ id: ID, url: ext('library/index.html'), tab: { url: ext('library/index.html') } }, ID)).toBe(true);
  });
  it('accepts the content script on YouTube', () => {
    const url = 'https://www.youtube.com/watch?v=aircAruvnKk';
    expect(isTrustedSender({ id: ID, url, tab: { url } }, ID)).toBe(true);
  });
  it('rejects a content script on any other site', () => {
    const url = 'https://example.com/';
    expect(isTrustedSender({ id: ID, url, tab: { url } }, ID)).toBe(false);
    expect(isTrustedSender({ id: ID, url: 'https://www.youtube.com.evil.example/', tab: { url: 'https://www.youtube.com.evil.example/' } }, ID)).toBe(false);
  });
  it('rejects other extensions, other extension origins and missing senders', () => {
    expect(isTrustedSender({ id: 'someoneelse', url: ext('panel/index.html') }, ID)).toBe(false);
    expect(isTrustedSender({ id: ID, url: 'chrome-extension://someoneelse/panel/index.html' }, ID)).toBe(false);
    expect(isTrustedSender({ id: ID }, ID)).toBe(false);
    expect(isTrustedSender(undefined, ID)).toBe(false);
  });
});
