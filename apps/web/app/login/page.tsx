import { redirect } from "next/navigation";
import { LoginClient } from "@/components/LoginClient";
import { isAuthRequired } from "@/lib/auth";

export default function LoginPage() {
  if (!isAuthRequired()) {
    redirect("/dashboard");
  }

  return <LoginClient />;
}
