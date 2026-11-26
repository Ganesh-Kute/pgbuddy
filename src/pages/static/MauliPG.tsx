import StaticPageLayout from "./StaticPageLayout";
import { BUSINESS, whatsappLink } from "@/lib/business-info";

// Mauli PG is run on PG Buddy and its tenants get WhatsApp messages (login codes, receipts, rent
// reminders) from PG Buddy's business number under the name "Mauli PG". Meta only approves a
// WhatsApp display name it can tie to the business on its website: this page is that link.
const MauliPG = () => (
  <StaticPageLayout title="Mauli PG">
    <div className="flex items-center gap-4">
      <img src="/custom-logo.png" alt="Mauli PG logo" width={96} height={96} className="rounded-2xl" />
      <p className="text-lg">
        <strong>Mauli PG</strong> (माऊली पीजी) is a paying guest accommodation in Pune, managed on PG Buddy.
      </p>
    </div>

    <h2 className="text-xl font-semibold text-foreground">Mauli PG on PG Buddy</h2>
    <p>
      Mauli PG is a brand operated with {BUSINESS.legalName} ({BUSINESS.udyamNumber}). Tenants of Mauli PG use the
      Mauli PG app, built and run by PG Buddy, to pay rent, download receipts, raise complaints and read notices.
    </p>

    <h2 className="text-xl font-semibold text-foreground">WhatsApp messages from Mauli PG</h2>
    <p>
      Login codes, rent receipts and rent reminders for Mauli PG tenants are sent on WhatsApp from PG Buddy's
      business number,{" "}
      <a href={whatsappLink} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
        {BUSINESS.whatsappDisplay}
      </a>
      , under the name <strong>Mauli PG</strong>.
    </p>

    <h2 className="text-xl font-semibold text-foreground">Contact</h2>
    <ul className="list-none space-y-1">
      <li>
        <strong>WhatsApp:</strong>{" "}
        <a href={whatsappLink} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
          {BUSINESS.whatsappDisplay}
        </a>
      </li>
      <li>
        <strong>City:</strong> Pune, Maharashtra
      </li>
    </ul>
  </StaticPageLayout>
);

export default MauliPG;
