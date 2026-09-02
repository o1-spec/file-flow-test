"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ArrowRightOnRectangleIcon } from "@heroicons/react/24/outline";

export default function Topbar() {
  const pathname = usePathname();
  const router = useRouter();
  const [loggedIn, setLoggedIn]               = useState(false);
  const [showLogoutModal, setShowLogoutModal] = useState(false);

  useEffect(() => {
    queueMicrotask(() => {
      setLoggedIn(!!localStorage.getItem("token"));
    });
  }, [pathname]);

  function confirmLogout() {
    localStorage.removeItem("token");
    localStorage.removeItem("isAdmin");
    setLoggedIn(false);
    setShowLogoutModal(false);
    router.push("/login");
  }

  return (
    <>
      <header className="sticky top-0 z-50 flex items-center justify-between px-6 h-16 w-full border-b border-white/8 bg-[#0a0a0a]/80 backdrop-blur-xl">
        {/* Brand */}
        <Link href="/" className="flex items-center gap-2 text-white font-bold text-lg tracking-tight hover:opacity-80 transition-opacity">
          FileFlow
        </Link>

       <nav className="flex items-center gap-1.5 sm:gap-2 text-sm font-medium">
          {loggedIn ? (
            <>
              <Link
                href="/admin"
                className={`transition-colors py-1.5 px-2.5 rounded-md ${pathname.startsWith("/admin") ? "text-white bg-white/10" : "text-gray-400 hover:text-white"}`}
              >
                Overview
              </Link>
              <Link
                href="/uploads"
                className={`transition-colors py-1.5 px-2.5 rounded-md ${pathname === "/uploads" ? "text-white bg-white/10" : "text-gray-400 hover:text-white"}`}
              >
                Files
              </Link>
              <Link
                href="/upload"
                className={`transition-colors py-1.5 px-2.5 rounded-md ${pathname === "/upload" ? "text-white bg-white/10" : "text-gray-400 hover:text-white"}`}
              >
                Jobs
              </Link>
              <Link
                href="/workspaces"
                className={`transition-colors py-1.5 px-2.5 rounded-md ${pathname.startsWith("/workspaces") ? "text-white bg-white/10" : "text-gray-400 hover:text-white"}`}
              >
                Workspaces
              </Link>
              <Link
                href="/operator"
                className={`group flex items-center gap-1.5 py-1 px-2.5 rounded-md border transition-all ${
                  pathname.startsWith("/operator")
                    ? "text-white bg-white/15 border-white/30 shadow-[0_0_12px_rgba(255,255,255,0.15)]"
                    : "text-gray-300 bg-white/5 border-white/10 hover:border-white/20 hover:text-white"
                }`}
              >
                <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-pulse"></span>
                <span>Operator</span>
                <span className="text-[10px] px-1 py-0.2 rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">MCPx</span>
              </Link>
              <button
                onClick={() => setShowLogoutModal(true)}
                className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-300 transition-colors ml-2 py-1.5 px-2"
                title="Sign out"
              >
                <ArrowRightOnRectangleIcon className="w-4 h-4" />
              </button>
            </>
          ) : (
            <>
              <Link
                href="/operator"
                className={`group flex items-center gap-1.5 py-1 px-2.5 rounded-md border transition-all ${
                  pathname.startsWith("/operator")
                    ? "text-white bg-white/15 border-white/30 shadow-[0_0_12px_rgba(255,255,255,0.15)]"
                    : "text-gray-300 bg-white/5 border-white/10 hover:border-white/20 hover:text-white"
                }`}
              >
                <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-pulse"></span>
                <span>Operator</span>
                <span className="text-[10px] px-1 py-0.2 rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">MCPx</span>
              </Link>
              <Link
                href="/login"
                className={`transition-colors py-1.5 px-3 rounded-md ${pathname === "/login" ? "text-white bg-white/10" : "text-gray-400 hover:text-white"}`}
              >
                Log In
              </Link>
              <Link
                href="/register"
                className="h-8 inline-flex items-center justify-center px-3.5 rounded-md bg-white text-black font-semibold hover:bg-gray-200 transition-all text-xs"
              >
                Get Started
              </Link>
            </>
          )}
        </nav>
      </header>

      {showLogoutModal && (
        <div className="fixed inset-0 z-200 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={() => setShowLogoutModal(false)}>
          <div className="w-full max-w-sm bg-[#111] border border-white/10 rounded-2xl p-6 shadow-2xl animate-in zoom-in-95 duration-200" onClick={(e) => e.stopPropagation()}>
            <div className="w-12 h-12 rounded-full bg-red-500/10 flex items-center justify-center text-red-500 mb-5">
              <ArrowRightOnRectangleIcon className="w-6 h-6" />
            </div>
            <h3 className="text-xl font-bold text-white mb-2">Sign out?</h3>
            <p className="text-gray-400 text-sm mb-6 leading-relaxed">
              You&apos;ll need to log back in to access your file pipeline and dashboard.
            </p>
            <div className="flex gap-3">
              <button className="flex-1 py-2.5 rounded-lg border border-white/10 text-white font-medium hover:bg-white/5 transition-colors" onClick={() => setShowLogoutModal(false)}>
                Cancel
              </button>
              <button className="flex-1 py-2.5 rounded-lg bg-red-500 text-white font-medium hover:bg-red-600 transition-colors" onClick={confirmLogout}>
                Sign Out
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
