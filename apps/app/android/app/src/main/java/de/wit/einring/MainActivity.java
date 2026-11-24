package de.wit.einring;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import de.wit.einring.appconfig.AppConfigPlugin;
import de.wit.einring.eindav.EinDavPlugin;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(EinDavPlugin.class);
        registerPlugin(AppConfigPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
