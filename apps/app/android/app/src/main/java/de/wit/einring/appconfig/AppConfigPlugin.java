package de.wit.einring.appconfig;

import android.content.Context;
import android.content.RestrictionsManager;
import android.os.Bundle;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * MDM managed configuration bridge (spec: +wit/specs/common/android-appconfig).
 * Reads the application restrictions the MDM pushed for this package — the
 * declared schema lives in res/xml/app_restrictions.xml and is registered via
 * the manifest's APP_RESTRICTIONS meta-data. Standard Android APIs only; no
 * vendor SDK, no logging of managed values (secrets may travel here).
 */
@CapacitorPlugin(name = "AppConfig")
public class AppConfigPlugin extends Plugin {

    static final String KEY_API_URL = "einring_api_url";

    /** Typed getter per consumed key (FR-004). */
    @PluginMethod
    public void getApiUrl(PluginCall call) {
        call.resolve(new JSObject().put("value", managedString(KEY_API_URL)));
    }

    /** Absent service, missing bundle, blank or whitespace-only -> null = "not configured" (FR-005). */
    private String managedString(String key) {
        RestrictionsManager restrictionsManager =
            (RestrictionsManager) getContext().getSystemService(Context.RESTRICTIONS_SERVICE);
        if (restrictionsManager == null) return null;
        Bundle restrictions = restrictionsManager.getApplicationRestrictions();
        if (restrictions == null) return null;
        String value = restrictions.getString(key);
        if (value == null || value.trim().isEmpty()) return null;
        return value;
    }
}
