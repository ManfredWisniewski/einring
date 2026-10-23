import { Tab, TabList, TabPanel, Tabs } from "react-aria-components";
import { useTranslation } from "react-i18next";
import { useSchoolMe } from "@/api/hooks";
import BillingView from "./views/BillingView";
import CalendarView from "./views/CalendarView";
import EventsView from "./views/EventsView";
import MessagesView from "./views/MessagesView";
import PeopleView from "./views/PeopleView";
import TodayView from "./views/TodayView";

/**
 * School module shell (D56): role-aware tabs. All data stays server-scoped —
 * tabs only decide what to *offer*, the BFF decides what to *return*.
 */
export default function SchoolPage() {
  const { t } = useTranslation();
  const me = useSchoolMe();

  if (me.isPending) return <p className="muted">{t("common.loading")}</p>;
  if (me.isError || !me.data || me.data.roles.length === 0) {
    return <p className="muted">{t("modules.school.noAccess")}</p>;
  }
  const roles = me.data.roles;
  const staff = roles.includes("admin") || roles.includes("teacher");
  const admin = roles.includes("admin");

  return (
    <Tabs className="tabs">
      <TabList className="tabs__list" aria-label={t("modules.school.nav")}>
        <Tab id="today" className="tabs__tab">
          {t("modules.school.tabs.today")}
        </Tab>
        <Tab id="calendar" className="tabs__tab">
          {t("modules.school.tabs.calendar")}
        </Tab>
        <Tab id="billing" className="tabs__tab">
          {t("modules.school.tabs.billing")}
        </Tab>
        <Tab id="messages" className="tabs__tab">
          {t("modules.school.tabs.messages")}
        </Tab>
        <Tab id="events" className="tabs__tab">
          {t("modules.school.tabs.events")}
        </Tab>
        {staff && (
          <Tab id="people" className="tabs__tab">
            {t("modules.school.tabs.people")}
          </Tab>
        )}
      </TabList>
      <TabPanel id="today">
        <TodayView roles={roles} person={me.data.person} />
      </TabPanel>
      <TabPanel id="calendar">
        <CalendarView staff={staff} admin={admin} person={me.data.person} />
      </TabPanel>
      <TabPanel id="billing">
        <BillingView admin={admin} />
      </TabPanel>
      <TabPanel id="messages">
        <MessagesView />
      </TabPanel>
      <TabPanel id="events">
        <EventsView staff={staff} person={me.data.person} />
      </TabPanel>
      {staff && (
        <TabPanel id="people">
          <PeopleView admin={admin} />
        </TabPanel>
      )}
    </Tabs>
  );
}
