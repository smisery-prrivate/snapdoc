// Snapdoc cloud settings. Snapdoc has its own Supabase project (not shared with other apps).
// A publishable key is designed to be shipped publicly; row level security on the server decides
// what a signed-in user may read or write, and visitors who are not signed in get nothing.
// If the project address changes, also change the connect-src entry of the
// Content-Security-Policy in index.html.
window.APP_CONFIG = window.APP_CONFIG || {
  supabaseUrl: 'https://gbhhsbmxdkpoejuvkgos.supabase.co',
  supabaseKey: 'sb_publishable_V9NGy2U_4mzR3IXrMQMLzA_M6QnpPmB'
};
