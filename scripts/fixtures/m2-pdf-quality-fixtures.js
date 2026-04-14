module.exports = {
  recommendedThresholds: {
    formPrecision: 0.8,
    formRecall: 0.8,
  },
  documents: [
    {
      filename: "2025 Tax Return Documents (Jimenez Julio).pdf",
      expectedPageCount: 22,
      valueAssertions: [
        {
          page: 1,
          label: "taxpayer identity",
          mustContain: ["Julio", "Jimenez", "500-00-1003"],
        },
        {
          page: 11,
          label: "w-2 employer wages and withholding",
          mustContain: ["GOODWILL OF CENTRAL AND COASTAL", "6,938", "56"],
        },
        {
          page: 21,
          label: "diagnostic summary preparer and invoice",
          mustContain: ["TAJI WHITE", "$220.00", "04-02-2026"],
        },
        {
          page: 15,
          label: "filing instructions due date",
          mustContain: ["Due date:", "04-15-2026"],
        },
        {
          page: 15,
          label: "filing instructions refund",
          mustContain: ["Refund:", "$586"],
        },
      ],
      formLabels: [
        { page: 1, expected: "Form 1040", label: "main return page" },
        {
          page: 2,
          expected: null,
          label: "Form 1040 page 2 — cross-ref 'from Schedule A' in body",
        },
        {
          page: 9,
          expected: null,
          label: "Form 9325 e-file acknowledgement — body ref 'Form 1040X'",
        },
        { page: 11, expected: "W-2", label: "wage statement" },
        { page: 12, expected: null, label: "EIC worksheet" },
        {
          page: 13,
          expected: null,
          label: "Carryover Worksheet — body phrase 'Itemized Deductions'",
        },
        { page: 15, expected: null, label: "filing instructions" },
      ],
    },
    {
      filename: "2025 Tax Return Documents (Whittaker Jordan).pdf",
      expectedPageCount: 25,
      valueAssertions: [
        {
          page: 1,
          label: "taxpayer identity",
          mustContain: ["Jordan", "Whittaker", "500-00-1002"],
        },
        {
          page: 6,
          label: "w-2 employer wages and withholding",
          mustContain: ["AdeM Industries", "27,645", "1,721"],
        },
        {
          page: 16,
          label: "diagnostic summary preparer and invoice",
          mustContain: ["TAJI WHITE", "$220.00", "04-02-2026"],
        },
        {
          page: 10,
          label: "filing instructions due date",
          mustContain: ["Due date:", "04-15-2026"],
        },
        {
          page: 10,
          label: "filing instructions refund",
          mustContain: ["Refund:", "$533"],
        },
      ],
      formLabels: [
        { page: 1, expected: "Form 1040", label: "main return page" },
        {
          page: 2,
          expected: null,
          label: "Form 1040 page 2 — cross-ref 'from Schedule A' in body",
        },
        {
          page: 4,
          expected: null,
          label: "Form 9325 e-file acknowledgement — body ref 'Form 1040X'",
        },
        { page: 6, expected: "W-2", label: "wage statement" },
        { page: 10, expected: null, label: "filing instructions" },
        { page: 16, expected: null, label: "diagnostic summary" },
      ],
    },
    {
      filename: "2025 Tax Return Documents (ELLINGTON PETER).pdf",
      expectedPageCount: 43,
      valueAssertions: [
        {
          page: 1,
          label: "taxpayer identity",
          mustContain: ["PETER", "ELLINGTON", "500-00-1005"],
        },
        {
          page: 25,
          label: "w-2 employer wages and withholding",
          mustContain: ["FRESHWATER FISH", "977,209", "280,484"],
        },
        {
          page: 42,
          label: "diagnostic summary preparer and invoice",
          mustContain: ["TAJI WHITE", "$220.00", "04-02-2026"],
        },
        {
          page: 35,
          label: "filing instructions due date",
          mustContain: ["Due date:", "04-15-2026"],
        },
        {
          page: 35,
          label: "filing instructions balance due",
          mustContain: ["Balance due:", "$99,641"],
        },
      ],
      formLabels: [
        { page: 1, expected: "Form 1040", label: "main return page" },
        {
          page: 2,
          expected: null,
          label: "Form 1040 page 2 — cross-ref 'from Schedule A' in body",
        },
        {
          page: 3,
          expected: null,
          label: "Schedule 2 — body ref 'self-employment tax from Schedule SE'",
        },
        { page: 5, expected: "Schedule B", label: "interest & dividends schedule" },
        { page: 21, expected: "1099-R", label: "pension distribution statement" },
        { page: 25, expected: "W-2", label: "wage statement" },
        {
          page: 33,
          expected: null,
          label: "Carryover Worksheet — body phrase 'Itemized Deductions'",
        },
        { page: 35, expected: null, label: "filing instructions" },
        { page: 42, expected: null, label: "diagnostic summary" },
      ],
    },
    {
      filename: "2025 Tax Return Documents (SHOEMAKER JOHNNY and ANNIE).pdf",
      expectedPageCount: 63,
      valueAssertions: [
        {
          page: 1,
          label: "primary taxpayer identity",
          mustContain: ["JOHNNY", "SHOEMAKER", "500-00-1001"],
        },
        {
          page: 1,
          label: "spouse identity",
          mustContain: ["ANNIE", "SHOEMAKER", "500-00-1000"],
        },
        {
          page: 29,
          label: "w-2 employer wages and withholding",
          mustContain: ["SHOE SHOP", "50,000", "7,500"],
        },
        {
          page: 50,
          label: "diagnostic summary preparer and invoice",
          mustContain: ["TAJI WHITE", "$510.00", "04-02-2026"],
        },
        {
          page: 43,
          label: "filing instructions balance due",
          mustContain: ["Balance due:", "$9,777"],
        },
      ],
      formLabels: [
        { page: 1, expected: "Form 1040", label: "main return page" },
        {
          page: 2,
          expected: null,
          label: "Form 1040 page 2 — cross-ref 'from Schedule A' in body",
        },
        {
          page: 4,
          expected: null,
          label: "Schedule 1 — body ref 'Clergy filing Schedule SE'",
        },
        {
          page: 5,
          expected: null,
          label: "Schedule 3 — body ref 'credit for child and dependent care from Form 2441'",
        },
        { page: 6, expected: "Schedule B", label: "interest & dividends schedule" },
        { page: 7, expected: "Schedule D", label: "capital gains schedule" },
        { page: 10, expected: "Schedule E", label: "rental/supplemental schedule" },
        {
          page: 19,
          expected: null,
          label: "Form 9325 e-file acknowledgement — body ref 'Form 1040X'",
        },
        {
          page: 26,
          expected: null,
          label: "Estimated Tax Worksheet — body phrase 'Schedule A'",
        },
        { page: 29, expected: "W-2", label: "wage statement" },
        {
          page: 40,
          expected: null,
          label: "Carryover Worksheet — body phrase 'Itemized Deductions'",
        },
        { page: 43, expected: null, label: "filing instructions" },
        { page: 50, expected: null, label: "diagnostic summary" },
        {
          page: 55,
          expected: null,
          label: "Georgia state return — body phrase 'Schedule A'",
        },
      ],
    },
    {
      filename: "2025 Tax Return Documents (SMITH TALIA S and Antonio Smith).pdf",
      expectedPageCount: 52,
      valueAssertions: [
        {
          page: 1,
          label: "primary taxpayer identity",
          mustContain: ["TALIA", "SMITH", "500-00-1004"],
        },
        {
          page: 1,
          label: "spouse identity",
          mustContain: ["Antonio", "Smith", "500-00-1008"],
        },
        {
          page: 24,
          label: "w-2 employer wages and withholding",
          mustContain: ["EMOJI STORE", "84,763", "12,515"],
        },
        {
          page: 41,
          label: "diagnostic summary preparer and invoice",
          mustContain: ["TAJI WHITE", "$514.00", "04-02-2026"],
        },
        {
          page: 34,
          label: "filing instructions balance due",
          mustContain: ["Balance due:", "$1,937"],
        },
      ],
      formLabels: [
        { page: 1, expected: "Form 1040", label: "main return page" },
        {
          page: 2,
          expected: null,
          label: "Form 1040 page 2 — cross-ref 'from Schedule A' in body",
        },
        {
          page: 4,
          expected: null,
          label: "Schedule 1 — body ref 'Clergy filing Schedule SE'",
        },
        {
          page: 5,
          expected: null,
          label: "Schedule 2 — body ref 'self-employment tax from Schedule SE'",
        },
        { page: 7, expected: "Schedule C", label: "business schedule" },
        { page: 9, expected: "Schedule SE", label: "self-employment tax schedule" },
        {
          page: 15,
          expected: null,
          label: "Form 9325 e-file acknowledgement — body ref 'Form 1040X'",
        },
        { page: 24, expected: "W-2", label: "wage statement" },
        {
          page: 26,
          expected: null,
          label: "EIC Worksheet B — body ref 'Filing Schedule SE'",
        },
        { page: 34, expected: null, label: "filing instructions" },
      ],
    },
    {
      filename: "2025 Tax Return Documents (Crestline Financial Group LLC).pdf",
      expectedPageCount: 41,
      valueAssertions: [
        {
          page: 8,
          label: "partner identity",
          mustContain: ["VICTORIA", "HAWKES", "123-45-6879"],
        },
        {
          page: 8,
          label: "partnership identity",
          mustContain: [
            "Crestline",
            "Financial",
            "Group",
            "LLC",
            "50-0001010",
          ],
        },
        {
          page: 8,
          label: "schedule k-1 ordinary business income",
          mustContain: ["Ordinary business income", "(9,395)"],
        },
        {
          page: 17,
          label: "statement deduction amount",
          mustContain: ["Equipment rent", "611,244"],
        },
        {
          page: 25,
          label: "filing instructions no refund or balance due",
          mustContain: ["neither a refund nor a balance due"],
        },
      ],
      formLabels: [
        { page: 1, expected: "Form 1065", label: "main partnership return" },
        { page: 8, expected: "Schedule K-1", label: "partner k-1" },
        { page: 11, expected: null, label: "schedule k-3 notification" },
        { page: 12, expected: "Schedule K-1", label: "second partner k-1" },
        { page: 17, expected: null, label: "supporting statement" },
        { page: 25, expected: null, label: "filing instructions" },
      ],
    },
  ],
};
