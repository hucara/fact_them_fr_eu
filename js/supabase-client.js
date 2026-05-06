import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const config = { ...(window.FACTHEM_CONFIG || {}) };
const isLocalDebug = ['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(window.location.hostname);

if (isLocalDebug && (!config.SUPABASE_URL || !config.SUPABASE_ANON)) {
  config.SUPABASE_URL = window.location.origin;
  config.SUPABASE_ANON = 'debug-anon-key';
}

if (!config.SUPABASE_URL || !config.SUPABASE_ANON) {
  throw new Error('Missing Supabase frontend configuration');
}

export const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_ANON);
