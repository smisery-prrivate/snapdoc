// Snapdoc cloud settings. Snapdoc gets its own Supabase project (not shared with other apps).
// Until that project exists both values stay empty and the app works on the device only.
// A publishable key is designed to be shipped publicly; row level security on the server decides
// what a signed-in user may read or write. When you fill these in, also add the project address to
// the connect-src entry of the Content-Security-Policy in index.html.
window.APP_CONFIG = window.APP_CONFIG || {
  // supabaseUrl: 'https://<project>.supabase.co',
  // supabaseKey: 'sb_publishable_...'
};
