package de.wit.einring.eindav;

import android.app.Service;
import android.content.Intent;
import android.os.IBinder;

/** Bound service exposing the contacts-authority sync adapter (D54). */
public class ContactsSyncService extends Service {

    private static EinDavSyncAdapter adapter;

    @Override
    public void onCreate() {
        synchronized (ContactsSyncService.class) {
            if (adapter == null) {
                adapter = new EinDavSyncAdapter(getApplicationContext());
            }
        }
    }

    @Override
    public IBinder onBind(Intent intent) {
        return adapter.getSyncAdapterBinder();
    }
}
