import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "@/i18n";
import { AppMenu } from "./AppMenu";

vi.mock("@/api/hooks", () => ({
  useModuleRegistry: () => ({
    data: {
      modules: [
        { id: "einhub", requires: [] },
        { id: "wiki", requires: ["nextcloud"] },
        { id: "settings", requires: [] },
      ],
    },
  }),
  useModulePrefs: () => ({ data: { disabled: [] }, isPending: false }),
  useSaveModulePrefs: () => ({ mutate: vi.fn(), isPending: false }),
}));

describe("AppMenu", () => {
  beforeAll(() => void i18n.changeLanguage("en"));

  it("opens the info dialog from the menu", async () => {
    const user = userEvent.setup();
    render(<AppMenu />);

    await user.click(screen.getByRole("button", { name: "Menu" }));
    await user.click(screen.getByRole("menuitem", { name: "Info" }));

    expect(screen.getByRole("dialog", { name: "About Einring" })).toBeInTheDocument();
    expect(screen.getByText("Version 0.1.0")).toBeInTheDocument();
  });

  it("lists enabled modules except einhub and settings", async () => {
    const user = userEvent.setup();
    render(<AppMenu />);

    await user.click(screen.getByRole("button", { name: "Menu" }));
    await user.click(screen.getByRole("menuitem", { name: "Modules" }));

    expect(screen.getByRole("dialog", { name: "Modules" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Wiki" })).toBeChecked();
    expect(screen.queryByText("EinHub")).not.toBeInTheDocument();
  });
});
