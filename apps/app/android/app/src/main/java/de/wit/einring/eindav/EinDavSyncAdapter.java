package de.wit.einring.eindav;

import android.accounts.Account;
import android.content.AbstractThreadedSyncAdapter;
import android.content.ContentProviderClient;
import android.content.Context;
import android.content.SyncResult;
import android.os.Bundle;

/**
 * Native sync adapter (D54). The actual DAV traffic runs through the BFF —
 * Nextcloud credentials never reach the device — so the adapter's job is to
 * kick the WebView plugin, which pushes already-parsed data back down via
 * {@link EinDavPlugin#syncContacts}/{@link EinDavPlugin#syncEvents}.
 * When the app is not running this is a harmless no-op.
 */
public class EinDavSyncAdapter extends AbstractThreadedSyncAdapter {

    public EinDavSyncAdapter(Context context) {
        super(context, true);
    }

    @Override
    public void onPerformSync(
        Account account,
        Bundle extras,
        String authority,
        ContentProviderClient provider,
        SyncResult syncResult
    ) {
        EinDavPlugin.notifySyncRequested();
    }
}
