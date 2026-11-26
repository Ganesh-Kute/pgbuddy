import { Link } from "react-router-dom";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

// The chart library is the biggest download in the app (~116 KB gzip). This file is loaded with import()
// from the dashboard, so owners see their numbers first and the charts fill in after.

const CHART_COLORS = ["hsl(var(--primary))", "hsl(var(--secondary))", "#f59e0b", "#ef4444", "#10b981", "#8b5cf6", "#06b6d4", "#ec4899"];

interface Props {
  monthlyPayments: { month: string; collected: number; pending: number }[];
  expensesByCategory: { name: string; value: number }[];
}

const DashboardCharts = ({ monthlyPayments, expensesByCategory }: Props) => (
  <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
    {/* Monthly Revenue Chart */}
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">Monthly Payments</CardTitle>
          <Button variant="ghost" size="sm" className="text-xs" asChild>
            <Link to="/dashboard/payments">View All</Link>
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {monthlyPayments.length > 0 ? (
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={monthlyPayments}>
              <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
              <XAxis dataKey="month" fontSize={11} />
              <YAxis fontSize={11} />
              <Tooltip />
              <Bar dataKey="collected" name="Collected" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
              <Bar dataKey="pending" name="Pending" fill="hsl(var(--muted-foreground))" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <p className="text-sm text-muted-foreground text-center py-12">No payment data yet</p>
        )}
      </CardContent>
    </Card>

    {/* Expense Breakdown */}
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">Expense Breakdown</CardTitle>
          <Button variant="ghost" size="sm" className="text-xs" asChild>
            <Link to="/dashboard/expenses">View All</Link>
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {expensesByCategory.length > 0 ? (
          <div className="flex items-center gap-6">
            <ResponsiveContainer width="50%" height={180}>
              <PieChart>
                <Pie data={expensesByCategory} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={70} innerRadius={35}>
                  {expensesByCategory.map((_, i) => (
                    <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
            <div className="space-y-1.5">
              {expensesByCategory.map((e, i) => (
                <div key={e.name} className="flex items-center gap-2 text-xs">
                  <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: CHART_COLORS[i % CHART_COLORS.length] }} />
                  <span className="capitalize text-muted-foreground">{e.name}</span>
                  <span className="font-medium ml-auto">₹{e.value.toLocaleString()}</span>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground text-center py-12">No expense data yet</p>
        )}
      </CardContent>
    </Card>
  </div>
);

export default DashboardCharts;
