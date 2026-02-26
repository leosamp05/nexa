import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { DashboardClient } from "@/components/DashboardClient";
import { appConfig } from "@/lib/config";
import { getCurrentUser, isAuthRequired } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { serializeJob } from "@/lib/serialize";

function getClientIp() {
  const requestHeaders = headers();
  const forwarded = requestHeaders.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return requestHeaders.get("cf-connecting-ip") ?? requestHeaders.get("x-real-ip") ?? "unknown";
}

export default async function DashboardPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const clientIp = getClientIp();
  const authRequired = isAuthRequired();

  const jobs = await prisma.job.findMany({
    where: { userId: user.id },
    include: { files: true },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return (
    <DashboardClient
      clientIp={clientIp}
      authRequired={authRequired}
      initialJobs={jobs.map(serializeJob)}
      captchaEnabled={appConfig.captchaEnabled}
      captchaSiteKey={appConfig.captchaSiteKey}
    />
  );
}
