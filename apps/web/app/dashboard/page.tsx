import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { DashboardClient } from "@/components/DashboardClient";
import { appConfig } from "@/lib/config";
import { extractClientIpFromHeaderValues, formatClientIpForUi } from "@/lib/ip";
import { getCurrentUser, isAuthRequired } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { serializeJob } from "@/lib/serialize";

async function getClientIp() {
  const requestHeaders = await headers();
  const rawIp = extractClientIpFromHeaderValues({
    forwarded: requestHeaders.get("x-forwarded-for"),
    cfConnectingIp: requestHeaders.get("cf-connecting-ip"),
    realIp: requestHeaders.get("x-real-ip"),
    proxyToken: requestHeaders.get("x-nexa-proxy-token"),
  });
  return formatClientIpForUi(rawIp);
}

export default async function DashboardPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const clientIp = await getClientIp();
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
      maxUploadBytes={appConfig.maxUploadBytes}
    />
  );
}
