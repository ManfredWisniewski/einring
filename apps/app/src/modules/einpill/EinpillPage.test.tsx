import { fireEvent, render, screen } from "@testing-library/react";
import type { EinpillMedication } from "~/api/types";
import i18n from "~/i18n";
import { EinpillPage } from "./EinpillPage";

const mocks = vi.hoisted(() => ({ useMedications: vi.fn() }));

vi.mock("~/api/hooks", () => ({
  useEinpillMedications: mocks.useMedications,
  useEinpillCreateMedication: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useEinpillDeleteMedication: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useEinpillPatchMedication: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useEinpillPutRevision: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useEinpillAddPackage: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useEinpillDeletePackage: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useEinpillPatchPackage: () => ({ mutate: vi.fn(), isPending: false, error: null }),
}));

function medication(input: Partial<EinpillMedication>): EinpillMedication {
  const projection: EinpillMedication["projection"] = {
    state: "untracked",
    currentPackageId: null,
    currentStartedDate: null,
    currentRemainingPills: 0,
    sparePackages: 0,
    totalRemainingPills: 0,
    remainingDays: 0,
    runoutDate: null,
  };
  return {
    id: input.id ?? "id",
    name: input.name ?? "Medication",
    pillsPerPackage: input.pillsPerPackage ?? 10,
    dailyUsage: input.dailyUsage ?? 1,
    archived: input.archived ?? false,
    revisions: input.revisions ?? [],
    packages: input.packages ?? [],
    projection: input.projection ?? projection,
  };
}

const rows = [
  medication({
    id: "early",
    name: "Early",
    dailyUsage: 1.5,
    projection: {
      state: "active",
      currentPackageId: "pkg-1",
      currentStartedDate: "2026-01-01",
      currentRemainingPills: 3.5,
      sparePackages: 2,
      totalRemainingPills: 23.5,
      remainingDays: 12,
      runoutDate: "2026-01-13",
    },
  }),
  medication({
    id: "empty",
    name: "NoPackage",
    projection: {
      state: "untracked",
      currentPackageId: null,
      currentStartedDate: null,
      currentRemainingPills: 0,
      sparePackages: 0,
      totalRemainingPills: 0,
      remainingDays: 0,
      runoutDate: null,
    },
  }),
  medication({
    id: "out",
    name: "Out",
    projection: {
      state: "exhausted",
      currentPackageId: null,
      currentStartedDate: null,
      currentRemainingPills: 0,
      sparePackages: 0,
      totalRemainingPills: 0,
      remainingDays: 0,
      runoutDate: "2026-01-01",
    },
  }),
  medication({ id: "archived", name: "Archived", archived: true }),
];

function setMedications(result: unknown) {
  mocks.useMedications.mockReturnValue(result);
}

describe("EinpillPage", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    mocks.useMedications.mockReset();
  });

  it("renders the required table columns, server order and explicit stock states", () => {
    setMedications({
      data: { medications: rows },
      isPending: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    });
    const { container } = render(<EinpillPage />);

    for (const column of [
      "Name",
      "Pills per day",
      "Pills per package",
      "Current since",
      "Current pills",
      "Spares",
      "Run-out date",
      "Remaining time",
    ]) {
      expect(screen.getByRole("columnheader", { name: column })).toBeInTheDocument();
    }
    const rowOrder = [...container.querySelectorAll("tbody tr")].map((tr) =>
      tr.querySelector("td button")?.textContent?.trim(),
    );
    expect(rowOrder).toEqual(["Early", "NoPackage", "Out", "Archived"]);
    expect(screen.getByText("3.5")).toBeInTheDocument();
    expect(screen.getByText("12 days")).toBeInTheDocument();
    expect(screen.getAllByText(/no package recorded/)).toHaveLength(2);
    expect(screen.getByText(/exhausted/)).toBeInTheDocument();
    expect(screen.getByText("archived")).toBeInTheDocument();
  });

  it("renders loading and empty states", () => {
    setMedications({
      data: undefined,
      isPending: true,
      isError: false,
      error: null,
      refetch: vi.fn(),
    });
    const loading = render(<EinpillPage />);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    loading.unmount();

    setMedications({
      data: { medications: [] },
      isPending: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    });
    render(<EinpillPage />);
    expect(screen.getByText("No medications yet.")).toBeInTheDocument();
  });

  it("shows validation when an edited medication name contains only whitespace", () => {
    setMedications({
      data: { medications: [medication({ id: "name-check", name: "Medication" })] },
      isPending: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    });
    render(<EinpillPage />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const name = screen.getByRole("textbox", { name: "Name" });
    fireEvent.change(name, { target: { value: "   " } });
    const form = name.closest("form");
    if (!form) throw new Error("medication name form not found");
    fireEvent.submit(form);
    expect(screen.getByText("Enter a name from 1 to 120 characters.")).toBeInTheDocument();
  });
});
