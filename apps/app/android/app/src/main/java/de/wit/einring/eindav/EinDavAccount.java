package de.wit.einring.eindav;

import android.accounts.Account;
import android.accounts.AccountManager;
import android.content.ContentResolver;
import android.content.Context;
import android.provider.CalendarContract;
import android.provider.ContactsContract;

/**
 * The local "einring" sync account. Device contacts/events synced by EinDAV are
 * written under this account so they stay grouped and removable (DAVx5 model,
 * D54).
 */
public final class EinDavAccount {

    public static final String TYPE = "de.wit.einring";

    private EinDavAccount() {}

    /** Returns the existing einring account or creates one and marks both authorities syncable. */
    public static Account getOrCreate(Context ctx, String name) {
        Account account = new Account(name, TYPE);
        AccountManager am = AccountManager.get(ctx);
        boolean found = false;
        for (Account a : am.getAccountsByType(TYPE)) {
            if (a.name.equals(name)) {
                found = true;
                break;
            }
        }
        if (!found) {
            am.addAccountExplicitly(account, null, null);
        }
        for (String authority : new String[] { ContactsContract.AUTHORITY, CalendarContract.AUTHORITY }) {
            ContentResolver.setIsSyncable(account, authority, 1);
            ContentResolver.setSyncAutomatically(account, authority, true);
        }
        return account;
    }
}
