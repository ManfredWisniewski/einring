package de.wit.einring.eindav;

import android.Manifest;
import android.accounts.Account;
import android.content.ContentProviderOperation;
import android.content.ContentProviderResult;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.ContentValues;
import android.database.Cursor;
import android.net.Uri;
import android.provider.CalendarContract;
import android.provider.ContactsContract;
import android.provider.ContactsContract.CommonDataKinds.Email;
import android.provider.ContactsContract.CommonDataKinds.Note;
import android.provider.ContactsContract.CommonDataKinds.Phone;
import android.provider.ContactsContract.CommonDataKinds.StructuredName;
import android.provider.ContactsContract.Data;
import android.provider.ContactsContract.RawContacts;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TimeZone;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * EinDAV native bridge (D54): writes BFF-parsed contacts/events into the
 * Android providers under the local "einring" account and pulls device-side
 * dirty rows back up for two-way sync. DAV traffic itself stays in the BFF —
 * the device never sees Nextcloud credentials.
 */
@CapacitorPlugin(
    name = "EinDav",
    permissions = {
        @Permission(
            alias = "contacts",
            strings = { Manifest.permission.READ_CONTACTS, Manifest.permission.WRITE_CONTACTS }
        ),
        @Permission(
            alias = "calendar",
            strings = { Manifest.permission.READ_CALENDAR, Manifest.permission.WRITE_CALENDAR }
        ),
    }
)
public class EinDavPlugin extends Plugin {

    private static EinDavPlugin instance;

    /** Called by {@link EinDavSyncAdapter} when the OS asks for a sync. */
    static void notifySyncRequested() {
        EinDavPlugin plugin = instance;
        if (plugin != null) {
            plugin.notifyListeners("syncRequested", new JSObject());
        }
    }

    @Override
    public void load() {
        instance = this;
    }

    // -- Public plugin methods ------------------------------------------------

    @PluginMethod
    public void syncContacts(PluginCall call) {
        if (getPermissionState("contacts") != PermissionState.GRANTED) {
            requestPermissionForAlias("contacts", call, "contactsPerm");
            return;
        }
        doSyncContacts(call);
    }

    @PluginMethod
    public void syncEvents(PluginCall call) {
        if (getPermissionState("calendar") != PermissionState.GRANTED) {
            requestPermissionForAlias("calendar", call, "calendarPerm");
            return;
        }
        doSyncEvents(call);
    }

    @PluginMethod
    public void pullChanges(PluginCall call) {
        boolean needContacts = getPermissionState("contacts") != PermissionState.GRANTED;
        boolean needCalendar = getPermissionState("calendar") != PermissionState.GRANTED;
        if (needContacts && needCalendar) {
            requestPermissionForAliases(new String[] { "contacts", "calendar" }, call, "pullPerm");
            return;
        }
        if (needContacts) {
            requestPermissionForAlias("contacts", call, "pullPerm");
            return;
        }
        if (needCalendar) {
            requestPermissionForAlias("calendar", call, "pullPerm");
            return;
        }
        doPullChanges(call);
    }

    @PluginMethod
    public void markClean(PluginCall call) {
        ContentResolver resolver = getContext().getContentResolver();
        stampClean(resolver, call.getArray("contacts"), true);
        stampClean(resolver, call.getArray("events"), false);
        call.resolve();
    }

    @PluginMethod
    public void requestSync(PluginCall call) {
        Account account = EinDavAccount.getOrCreate(getContext(), call.getString("account", "einring"));
        for (String authority : new String[] {
            ContactsContract.AUTHORITY,
            CalendarContract.AUTHORITY,
        }) {
            ContentResolver.requestSync(account, authority, new android.os.Bundle());
        }
        call.resolve();
    }

    @PermissionCallback
    private void contactsPerm(PluginCall call) {
        if (getPermissionState("contacts") == PermissionState.GRANTED) {
            doSyncContacts(call);
        } else {
            call.reject("contacts permission denied");
        }
    }

    @PermissionCallback
    private void calendarPerm(PluginCall call) {
        if (getPermissionState("calendar") == PermissionState.GRANTED) {
            doSyncEvents(call);
        } else {
            call.reject("calendar permission denied");
        }
    }

    @PermissionCallback
    private void pullPerm(PluginCall call) {
        if (
            getPermissionState("contacts") == PermissionState.GRANTED &&
            getPermissionState("calendar") == PermissionState.GRANTED
        ) {
            doPullChanges(call);
        } else {
            call.reject("sync permissions denied");
        }
    }

    // -- Contacts -------------------------------------------------------------

    private void doSyncContacts(PluginCall call) {
        try {
            ContentResolver resolver = getContext().getContentResolver();
            Account account = EinDavAccount.getOrCreate(getContext(), call.getString("account", "einring"));
            JSArray contacts = call.getArray("contacts", new JSArray());

            // uid (SYNC1) -> raw contact id for our account
            Map<String, Long> existing = new HashMap<>();
            try (
                Cursor c = resolver.query(
                    RawContacts.CONTENT_URI,
                    new String[] { RawContacts._ID, RawContacts.SYNC1 },
                    RawContacts.ACCOUNT_TYPE + "=? AND " + RawContacts.ACCOUNT_NAME + "=?",
                    new String[] { EinDavAccount.TYPE, account.name },
                    null
                )
            ) {
                while (c != null && c.moveToNext()) {
                    String uid = c.getString(1);
                    existing.put(uid == null ? "" : uid, c.getLong(0));
                }
            }

            ArrayList<ContentProviderOperation> ops = new ArrayList<>();
            Set<String> seen = new HashSet<>();
            int synced = 0;
            for (int i = 0; i < contacts.length(); i++) {
                JSONObject contact = contacts.getJSONObject(i);
                String uid = contact.optString("uid", "");
                seen.add(uid);
                Long rawId = existing.get(uid);
                int backRef = rawId == null ? ops.size() : -1;

                if (rawId == null) {
                    ops.add(
                        ContentProviderOperation.newInsert(RawContacts.CONTENT_URI)
                            .withValue(RawContacts.ACCOUNT_TYPE, EinDavAccount.TYPE)
                            .withValue(RawContacts.ACCOUNT_NAME, account.name)
                            .withValue(RawContacts.SYNC1, uid)
                            .build()
                    );
                } else {
                    ops.add(
                        ContentProviderOperation.newDelete(Data.CONTENT_URI)
                            .withSelection(Data.RAW_CONTACT_ID + "=?", new String[] { String.valueOf(rawId) })
                            .build()
                    );
                }
                addContactRows(ops, contact, rawId, backRef);
                synced++;
                if (ops.size() > 400) {
                    resolver.applyBatch(ContactsContract.AUTHORITY, ops);
                    ops.clear();
                }
            }

            for (Map.Entry<String, Long> e : existing.entrySet()) {
                if (!seen.contains(e.getKey())) {
                    ops.add(
                        ContentProviderOperation.newDelete(
                            ContentUris.withAppendedId(RawContacts.CONTENT_URI, e.getValue())
                        ).build()
                    );
                }
            }
            if (!ops.isEmpty()) {
                resolver.applyBatch(ContactsContract.AUTHORITY, ops);
            }

            JSObject result = new JSObject();
            result.put("synced", synced);
            call.resolve(result);
        } catch (Exception e) {
            call.reject("contact sync failed: " + e.getMessage(), e);
        }
    }

    private void addContactRows(
        ArrayList<ContentProviderOperation> ops,
        JSONObject contact,
        Long rawId,
        int backRef
    ) {
        String fn = contact.optString("fn", "");
        ContentProviderOperation.Builder name = rawId == null
            ? ContentProviderOperation.newInsert(Data.CONTENT_URI)
                .withValueBackReference(Data.RAW_CONTACT_ID, backRef)
            : ContentProviderOperation.newInsert(Data.CONTENT_URI)
                .withValue(Data.RAW_CONTACT_ID, rawId);
        ops.add(
            name.withValue(Data.MIMETYPE, StructuredName.CONTENT_ITEM_TYPE)
                .withValue(StructuredName.DISPLAY_NAME, fn)
                .build()
        );

        JSONArray emails = contact.optJSONArray("emails");
        if (emails != null) {
            for (int i = 0; i < emails.length(); i++) {
                ContentProviderOperation.Builder b = rawId == null
                    ? ContentProviderOperation.newInsert(Data.CONTENT_URI)
                        .withValueBackReference(Data.RAW_CONTACT_ID, backRef)
                    : ContentProviderOperation.newInsert(Data.CONTENT_URI)
                        .withValue(Data.RAW_CONTACT_ID, rawId);
                ops.add(
                    b.withValue(Data.MIMETYPE, Email.CONTENT_ITEM_TYPE)
                        .withValue(Email.ADDRESS, emails.optString(i))
                        .withValue(Email.TYPE, Email.TYPE_HOME)
                        .build()
                );
            }
        }
        JSONArray tels = contact.optJSONArray("tels");
        if (tels != null) {
            for (int i = 0; i < tels.length(); i++) {
                ContentProviderOperation.Builder b = rawId == null
                    ? ContentProviderOperation.newInsert(Data.CONTENT_URI)
                        .withValueBackReference(Data.RAW_CONTACT_ID, backRef)
                    : ContentProviderOperation.newInsert(Data.CONTENT_URI)
                        .withValue(Data.RAW_CONTACT_ID, rawId);
                ops.add(
                    b.withValue(Data.MIMETYPE, Phone.CONTENT_ITEM_TYPE)
                        .withValue(Phone.NUMBER, tels.optString(i))
                        .withValue(Phone.TYPE, Phone.TYPE_MOBILE)
                        .build()
                );
            }
        }
        String note = contact.optString("note", null);
        if (note != null && !note.isEmpty()) {
            ContentProviderOperation.Builder b = rawId == null
                ? ContentProviderOperation.newInsert(Data.CONTENT_URI)
                    .withValueBackReference(Data.RAW_CONTACT_ID, backRef)
                : ContentProviderOperation.newInsert(Data.CONTENT_URI)
                    .withValue(Data.RAW_CONTACT_ID, rawId);
            ops.add(
                b.withValue(Data.MIMETYPE, Note.CONTENT_ITEM_TYPE).withValue(Note.NOTE, note).build()
            );
        }
    }

    // -- Calendar -------------------------------------------------------------

    private void doSyncEvents(PluginCall call) {
        try {
            ContentResolver resolver = getContext().getContentResolver();
            Account account = EinDavAccount.getOrCreate(getContext(), call.getString("account", "einring"));
            String calName = call.getString("calendar", "einring");
            long calendarId = ensureCalendar(resolver, account, calName);
            JSArray events = call.getArray("events", new JSArray());

            Map<String, Long> existing = new HashMap<>();
            try (
                Cursor c = resolver.query(
                    CalendarContract.Events.CONTENT_URI,
                    new String[] { CalendarContract.Events._ID, CalendarContract.Events._SYNC_ID },
                    CalendarContract.Events.CALENDAR_ID + "=?",
                    new String[] { String.valueOf(calendarId) },
                    null
                )
            ) {
                while (c != null && c.moveToNext()) {
                    String uid = c.getString(1);
                    if (uid != null) existing.put(uid, c.getLong(0));
                }
            }

            Set<String> seen = new HashSet<>();
            int synced = 0;
            for (int i = 0; i < events.length(); i++) {
                JSONObject event = events.getJSONObject(i);
                String uid = event.optString("uid", "");
                seen.add(uid);
                ContentValues v = eventValues(calendarId, event);
                Long id = existing.get(uid);
                if (id == null) {
                    Uri uri = asSyncAdapter(CalendarContract.Events.CONTENT_URI, account);
                    resolver.insert(uri, v);
                } else {
                    Uri uri = asSyncAdapter(ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, id), account);
                    resolver.update(uri, v, null, null);
                }
                synced++;
            }
            for (Map.Entry<String, Long> e : existing.entrySet()) {
                if (!seen.contains(e.getKey())) {
                    Uri uri = asSyncAdapter(
                        ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, e.getValue()),
                        account
                    );
                    resolver.delete(uri, null, null);
                }
            }

            JSObject result = new JSObject();
            result.put("synced", synced);
            call.resolve(result);
        } catch (Exception e) {
            call.reject("event sync failed: " + e.getMessage(), e);
        }
    }

    private long ensureCalendar(ContentResolver resolver, Account account, String name) {
        try (
            Cursor c = resolver.query(
                CalendarContract.Calendars.CONTENT_URI,
                new String[] { CalendarContract.Calendars._ID },
                CalendarContract.Calendars.ACCOUNT_NAME + "=? AND " + CalendarContract.Calendars.ACCOUNT_TYPE + "=?",
                new String[] { account.name, EinDavAccount.TYPE },
                null
            )
        ) {
            if (c != null && c.moveToNext()) return c.getLong(0);
        }
        ContentValues v = new ContentValues();
        v.put(CalendarContract.Calendars.ACCOUNT_NAME, account.name);
        v.put(CalendarContract.Calendars.ACCOUNT_TYPE, EinDavAccount.TYPE);
        v.put(CalendarContract.Calendars.NAME, "einring");
        v.put(CalendarContract.Calendars.CALENDAR_DISPLAY_NAME, name);
        v.put(CalendarContract.Calendars.CALENDAR_COLOR, 0xFF3B82F6);
        v.put(CalendarContract.Calendars.CALENDAR_ACCESS_LEVEL, CalendarContract.Calendars.CAL_ACCESS_OWNER);
        v.put(CalendarContract.Calendars.OWNER_ACCOUNT, account.name);
        v.put(CalendarContract.Calendars.SYNC_EVENTS, 1);
        Uri uri = resolver.insert(asSyncAdapter(CalendarContract.Calendars.CONTENT_URI, account), v);
        return uri == null ? -1 : ContentUris.parseId(uri);
    }

    private ContentValues eventValues(long calendarId, JSONObject event) {
        ContentValues v = new ContentValues();
        boolean allDay = event.optBoolean("allDay", false);
        String start = event.optString("start", "");
        String end = event.optString("end", "");
        v.put(CalendarContract.Events.CALENDAR_ID, calendarId);
        v.put(CalendarContract.Events._SYNC_ID, event.optString("uid", ""));
        v.put(CalendarContract.Events.TITLE, event.optString("summary", ""));
        v.put(CalendarContract.Events.DESCRIPTION, event.isNull("description") ? null : event.optString("description"));
        v.put(CalendarContract.Events.EVENT_LOCATION, event.isNull("location") ? null : event.optString("location"));
        v.put(CalendarContract.Events.ALL_DAY, allDay ? 1 : 0);
        v.put(CalendarContract.Events.EVENT_TIMEZONE, allDay ? "UTC" : TimeZone.getDefault().getID());
        v.put(CalendarContract.Events.DTSTART, parseDate(start, allDay));
        v.put(CalendarContract.Events.DTEND, parseDate(end.isEmpty() ? start : end, allDay));
        return v;
    }

    /** `YYYY-MM-DD[THH:mm]` → millis; all-day values are UTC (RFC 5545 DATE). */
    private static long parseDate(String value, boolean allDay) {
        try {
            if (allDay) {
                SimpleDateFormat f = new SimpleDateFormat("yyyy-MM-dd", Locale.US);
                f.setTimeZone(TimeZone.getTimeZone("UTC"));
                Date d = f.parse(value);
                return d == null ? System.currentTimeMillis() : d.getTime();
            }
            SimpleDateFormat f = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm", Locale.US);
            Date d = f.parse(value);
            return d == null ? System.currentTimeMillis() : d.getTime();
        } catch (Exception e) {
            return System.currentTimeMillis();
        }
    }

    private static String formatDate(long millis, boolean allDay) {
        SimpleDateFormat f = allDay
            ? new SimpleDateFormat("yyyy-MM-dd", Locale.US)
            : new SimpleDateFormat("yyyy-MM-dd'T'HH:mm", Locale.US);
        if (allDay) f.setTimeZone(TimeZone.getTimeZone("UTC"));
        return f.format(new Date(millis));
    }

    private static Uri asSyncAdapter(Uri uri, Account account) {
        return uri.buildUpon()
            .appendQueryParameter(CalendarContract.CALLER_IS_SYNCADAPTER, "true")
            .appendQueryParameter(CalendarContract.Calendars.ACCOUNT_NAME, account.name)
            .appendQueryParameter(CalendarContract.Calendars.ACCOUNT_TYPE, account.type)
            .build();
    }

    // -- Pull device-side changes (two-way, D54) ------------------------------

    private void doPullChanges(PluginCall call) {
        try {
            ContentResolver resolver = getContext().getContentResolver();
            Account account = EinDavAccount.getOrCreate(getContext(), call.getString("account", "einring"));
            JSObject result = new JSObject();
            result.put("contacts", dirtyContacts(resolver, account));
            result.put("events", dirtyEvents(resolver, account));
            call.resolve(result);
        } catch (Exception e) {
            call.reject("pull failed: " + e.getMessage(), e);
        }
    }

    private JSArray dirtyContacts(ContentResolver resolver, Account account) throws JSONException {
        JSArray out = new JSArray();
        try (
            Cursor c = resolver.query(
                RawContacts.CONTENT_URI,
                new String[] { RawContacts._ID, RawContacts.SYNC1 },
                RawContacts.ACCOUNT_TYPE + "=? AND " + RawContacts.ACCOUNT_NAME + "=? AND " + RawContacts.DIRTY + "=1",
                new String[] { EinDavAccount.TYPE, account.name },
                null
            )
        ) {
            while (c != null && c.moveToNext()) {
                long rawId = c.getLong(0);
                JSObject contact = new JSObject();
                contact.put("id", rawId);
                contact.put("uid", c.isNull(1) ? JSONObject.NULL : c.getString(1));
                String fn = "";
                JSArray emails = new JSArray();
                JSArray tels = new JSArray();
                String note = null;
                try (
                    Cursor d = resolver.query(
                        Data.CONTENT_URI,
                        new String[] { Data.MIMETYPE, Data.DATA1 },
                        Data.RAW_CONTACT_ID + "=?",
                        new String[] { String.valueOf(rawId) },
                        null
                    )
                ) {
                    while (d != null && d.moveToNext()) {
                        String mime = d.getString(0);
                        String value = d.getString(1);
                        if (StructuredName.CONTENT_ITEM_TYPE.equals(mime)) fn = value;
                        else if (Email.CONTENT_ITEM_TYPE.equals(mime)) emails.put(value);
                        else if (Phone.CONTENT_ITEM_TYPE.equals(mime)) tels.put(value);
                        else if (Note.CONTENT_ITEM_TYPE.equals(mime)) note = value;
                    }
                }
                contact.put("fn", fn);
                contact.put("emails", emails);
                contact.put("tels", tels);
                contact.put("note", note == null ? JSONObject.NULL : note);
                out.put(contact);
            }
        }
        return out;
    }

    private JSArray dirtyEvents(ContentResolver resolver, Account account) throws JSONException {
        JSArray out = new JSArray();
        try (
            Cursor cal = resolver.query(
                CalendarContract.Calendars.CONTENT_URI,
                new String[] { CalendarContract.Calendars._ID },
                CalendarContract.Calendars.ACCOUNT_NAME + "=? AND " + CalendarContract.Calendars.ACCOUNT_TYPE + "=?",
                new String[] { account.name, EinDavAccount.TYPE },
                null
            )
        ) {
            while (cal != null && cal.moveToNext()) {
                long calendarId = cal.getLong(0);
                try (
                    Cursor c = resolver.query(
                        CalendarContract.Events.CONTENT_URI,
                        new String[] {
                            CalendarContract.Events._ID,
                            CalendarContract.Events._SYNC_ID,
                            CalendarContract.Events.TITLE,
                            CalendarContract.Events.DESCRIPTION,
                            CalendarContract.Events.EVENT_LOCATION,
                            CalendarContract.Events.DTSTART,
                            CalendarContract.Events.DTEND,
                            CalendarContract.Events.ALL_DAY,
                        },
                        CalendarContract.Events.CALENDAR_ID + "=? AND " + CalendarContract.Events.DIRTY + "=1",
                        new String[] { String.valueOf(calendarId) },
                        null
                    )
                ) {
                    while (c != null && c.moveToNext()) {
                        boolean allDay = c.getInt(7) == 1;
                        JSObject event = new JSObject();
                        event.put("id", c.getLong(0));
                        event.put("uid", c.isNull(1) ? JSONObject.NULL : c.getString(1));
                        event.put("summary", c.isNull(2) ? "" : c.getString(2));
                        event.put("description", c.isNull(3) ? JSONObject.NULL : c.getString(3));
                        event.put("location", c.isNull(4) ? JSONObject.NULL : c.getString(4));
                        event.put("start", formatDate(c.getLong(5), allDay));
                        event.put("end", formatDate(c.isNull(6) ? c.getLong(5) : c.getLong(6), allDay));
                        event.put("allDay", allDay);
                        out.put(event);
                    }
                }
            }
        }
        return out;
    }

    /** Clears DIRTY and stamps the server uid on freshly pushed rows ({id, uid} pairs). */
    private void stampClean(ContentResolver resolver, JSArray rows, boolean contacts) {
        if (rows == null) return;
        for (int i = 0; i < rows.length(); i++) {
            JSONObject row = rows.optJSONObject(i);
            if (row == null) continue;
            long id = row.optLong("id", -1);
            if (id < 0) continue;
            ContentValues v = new ContentValues();
            v.put(contacts ? RawContacts.DIRTY : CalendarContract.Events.DIRTY, 0);
            String uid = row.optString("uid", null);
            if (uid != null) {
                v.put(contacts ? RawContacts.SYNC1 : CalendarContract.Events._SYNC_ID, uid);
            }
            Uri uri = contacts
                ? ContentUris.withAppendedId(RawContacts.CONTENT_URI, id)
                : asSyncAdapter(
                    ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, id),
                    EinDavAccount.getOrCreate(getContext(), "einring")
                );
            resolver.update(uri, v, null, null);
        }
    }
}
