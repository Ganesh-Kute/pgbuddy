import { useEffect, useState } from "react";
import { usePageData, deferSetters, applyTo } from "@/hooks/usePageData";
import { FileText, CheckCircle, XCircle, Clock, Eye } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import DashboardLayout from "@/components/dashboard/DashboardLayout";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { useStaffAccess } from "@/hooks/useStaffAccess";
import { openStorageFile } from "@/lib/storage-files";

interface TenantDoc {
  id: string;
  tenant_id: string;
  document_type: string;
  document_name: string;
  url: string;
  storage_path?: string | null;
  status: string;
  notes: string | null;
  created_at: string;
  properties?: { name: string };
}

const docTypeLabels: Record<string, string> = {
  aadhaar: "Aadhaar Card", pan: "PAN Card", passport: "Passport",
  driving_license: "Driving License", college_id: "College ID",
  agreement: "Rent Agreement", other: "Other",
};

const Documents = () => {
  const { user } = useAuth();
  const { toast } = useToast();
  const { effectiveOwnerId, loading: staffLoading } = useStaffAccess();
  const [docs, setDocs] = useState<TenantDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [properties, setProperties] = useState<{ id: string; name: string }[]>([]);
  const [selectedProp, setSelectedProp] = useState("all");

  const fetchDocs_load = async () => {

    const later = deferSetters<typeof fetchDocs_setters>();

    await (async () => {
    if (!effectiveOwnerId) return;
    const [docRes, propRes] = await Promise.all([
      supabase.from("tenant_documents").select("*, properties(name)").order("created_at", { ascending: false }),
      supabase.from("properties").select("id, name").eq("owner_id", effectiveOwnerId),
    ]);
    later((s) => s.setDocs(docRes.data ?? []));
    later((s) => s.setProperties(propRes.data ?? []));
    later((s) => s.setLoading(false));
  })();

    return later.commits;

  };

  const fetchDocs_setters = { setDocs, setProperties, setLoading };

  const { refresh: fetchDocs } = usePageData(["Documents", effectiveOwnerId], fetchDocs_load, applyTo(fetchDocs_setters), !staffLoading);

  const updateStatus = async (id: string, status: string) => {
    await supabase.from("tenant_documents").update({
      status,
      reviewed_by: user?.id,
      reviewed_at: new Date().toISOString(),
    }).eq("id", id);
    toast({ title: `Document ${status}` });
    fetchDocs();
  };

  const filtered = selectedProp === "all" ? docs : docs.filter(d => d.properties?.name === selectedProp);

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Tenant Documents</h1>
            <p className="text-muted-foreground">Review and verify tenant ID proofs & agreements</p>
          </div>
          {properties.length > 1 && (
            <Select value={selectedProp} onValueChange={setSelectedProp}>
              <SelectTrigger className="w-48"><SelectValue placeholder="Filter" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Properties</SelectItem>
                {properties.map(p => <SelectItem key={p.id} value={p.name}>{p.name}</SelectItem>)}
              </SelectContent>
            </Select>
          )}
        </div>

        {loading ? (
          <p className="text-muted-foreground">Loading...</p>
        ) : filtered.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="flex flex-col items-center justify-center py-12 text-center">
              <FileText className="w-12 h-12 text-muted-foreground mb-4" />
              <h3 className="text-lg font-semibold mb-2">No documents</h3>
              <p className="text-muted-foreground">Tenant documents will appear here once uploaded</p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {filtered.map(d => (
              <Card key={d.id}>
                <CardContent className="flex items-center justify-between py-4">
                  <div className="flex items-center gap-4">
                    <FileText className="w-5 h-5 text-primary" />
                    <div>
                      <p className="font-medium">{docTypeLabels[d.document_type] || d.document_type}</p>
                      <p className="text-sm text-muted-foreground">
                        {d.document_name} · {d.properties?.name} · {new Date(d.created_at).toLocaleDateString()}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        const ok = await openStorageFile("tenant-documents", d.storage_path || d.url);
                        if (!ok) toast({ title: "Could not open the document", description: "It may have been removed, or you may not have access.", variant: "destructive" });
                      }}
                    >
                      <Eye className="w-3 h-3 mr-1" /> View
                    </Button>
                    {d.status === "pending" && (
                      <>
                        <Button size="sm" variant="outline" className="text-success border-success" onClick={() => updateStatus(d.id, "approved")}>
                          <CheckCircle className="w-3 h-3 mr-1" /> Approve
                        </Button>
                        <Button size="sm" variant="outline" className="text-destructive border-destructive" onClick={() => updateStatus(d.id, "rejected")}>
                          <XCircle className="w-3 h-3 mr-1" /> Reject
                        </Button>
                      </>
                    )}
                    <Badge className={d.status === "approved" ? "bg-success" : d.status === "rejected" ? "bg-destructive" : "bg-warning"}>
                      {d.status}
                    </Badge>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
};

export default Documents;
