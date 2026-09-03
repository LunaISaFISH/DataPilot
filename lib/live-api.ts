'use client';

import { useSyncExternalStore } from 'react';

const configuredApiBase = process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, '') || null;

function isLocalBrowser() {
  return window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
}

function subscribe() {
  return () => undefined;
}

export function resolveApiBase() {
  if (configuredApiBase) return configuredApiBase;
  return isLocalBrowser() ? 'http://localhost:8000' : null;
}

export function useLiveApiAvailable() {
  return useSyncExternalStore(
    subscribe,
    () => Boolean(configuredApiBase || isLocalBrowser()),
    () => Boolean(configuredApiBase),
  );
}
