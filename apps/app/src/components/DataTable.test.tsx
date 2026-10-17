import { render, screen } from "@testing-library/react";
import i18n from "@/i18n";
import { DataTable, formatCell } from "./DataTable";

const t = (k: string) => k;

describe("formatCell", () => {
  it("formats primitives, booleans, arrays and objects", () => {
    expect(formatCell(null, t)).toBe("");
    expect(formatCell("x", t)).toBe("x");
    expect(formatCell(42, t)).toBe("42");
    expect(formatCell(true, t)).toBe("common.yes");
    expect(formatCell(["a", "b"], t)).toBe("a, b");
    expect(formatCell({ k: 1 }, t)).toBe('{"k":1}');
  });
});

describe("DataTable", () => {
  beforeAll(() => i18n.changeLanguage("en"));

  it("renders headers and cells by column id", () => {
    render(
      <DataTable
        columns={[
          { id: 1, title: "Name", type: "text" },
          { id: 2, title: "Done", type: "check" },
        ]}
        rows={[{ id: 10, cells: { "1": "Ring", "2": true } }]}
      />,
    );
    expect(screen.getByRole("columnheader", { name: "Name" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "Ring" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "yes" })).toBeInTheDocument();
  });

  it("shows the empty state", () => {
    render(<DataTable columns={[{ id: 1, title: "Name", type: "text" }]} rows={[]} />);
    expect(screen.getByText("This view has no rows.")).toBeInTheDocument();
  });
});
