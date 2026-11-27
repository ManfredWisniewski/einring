import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import type { EinHubNotification } from "~/api/types";
import i18n from "~/i18n";
import { NotificationRow } from "./EinHubPage";

vi.mock("~/api/hooks", () => ({
  useEinHubMarkRead: () => ({ mutate: vi.fn() }),
  useEinHubNotifications: () => ({ data: undefined, isPending: false, isError: false }),
  useEinHubReadAll: () => ({ mutate: vi.fn(), isPending: false }),
  useModulePrefs: () => ({ data: { disabled: [] } }),
  useModuleRegistry: () => ({ data: { modules: [] } }),
}));

const notification: EinHubNotification = {
  id: 1,
  module: "einpill",
  title: "Fallback title",
  body: "Fallback body",
  at: "2026-01-01T00:00:00.000Z",
  read: false,
  i18n: {
    titleKey: "modules.einpill.notificationRestockTitle",
    titleParams: { name: "Testmed" },
    bodyKey: "modules.einpill.notificationRestockBody",
    bodyParams: { runoutDate: "2026-01-02", days: 4 },
  },
};

function renderRow(n: EinHubNotification) {
  return render(
    <MemoryRouter>
      <NotificationRow n={n} enabled={false} />
    </MemoryRouter>,
  );
}

describe("EinHub structured notification localization", () => {
  it.each([
    [
      "de",
      "Testmed geht bald zur Neige",
      "Voraussichtlich aufgebraucht am 2026-01-02 (noch 4 Tage).",
    ],
    ["en", "Testmed runs out soon", "Projected run-out date: 2026-01-02 (4 days remaining)."],
    [
      "fr",
      "Testmed sera bientôt épuisé",
      "Date d'épuisement prévue : 2026-01-02 (4 jours restants).",
    ],
    [
      "ru",
      "Testmed скоро закончится",
      "Прогнозируемая дата окончания: 2026-01-02 (осталось 4 дн.).",
    ],
  ] as const)("renders EinPill metadata in %s", async (language, title, body) => {
    await i18n.changeLanguage(language);
    const { container } = renderRow(notification);
    expect(container.textContent).toContain(title);
    expect(container.textContent).toContain(body);
  });

  it("renders the exhausted-stock metadata variant", async () => {
    await i18n.changeLanguage("en");
    const { container } = renderRow({
      ...notification,
      i18n: {
        titleKey: "modules.einpill.notificationOutTitle",
        titleParams: { name: "Testmed" },
        bodyKey: "modules.einpill.notificationOutBody",
        bodyParams: { runoutDate: "2026-01-02" },
      },
    });
    expect(container.textContent).toContain("Testmed is out of stock");
    expect(container.textContent).toContain("Stock has been exhausted since 2026-01-02.");
  });

  it("keeps the plain-text fallback without metadata or when keys are missing", async () => {
    await i18n.changeLanguage("en");
    const plain = renderRow({ ...notification, i18n: undefined });
    expect(plain.container.textContent).toContain("Fallback title");
    expect(plain.container.textContent).toContain("Fallback body");
    plain.unmount();

    const missing = renderRow({
      ...notification,
      i18n: { titleKey: "modules.einpill.missingTitle", bodyKey: "modules.einpill.missingBody" },
    });
    expect(missing.container.textContent).toContain("Fallback title");
    expect(missing.container.textContent).toContain("Fallback body");
  });
});
