import { RequestForm } from "@/components/forms";
import { Card, PageHeader } from "@/components/ui";

export default function NewRequestPage() {
  return (
    <>
      <PageHeader
        title="New purchase request"
        description="Requests start as pending and wait for an approval decision."
      />
      <Card className="max-w-3xl">
        <RequestForm />
      </Card>
    </>
  );
}
