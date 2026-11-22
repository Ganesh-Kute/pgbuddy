import { Link } from "react-router-dom";
import { Building2, MessageCircle, MapPin, BadgeCheck, Facebook, Twitter, Instagram, Linkedin } from "lucide-react";
import { BUSINESS, whatsappLink } from "@/lib/business-info";

const Footer = () => {
  const footerLinks = {
    product: [
      { name: "Features", href: "/features" },
      { name: "Pricing", href: "/pricing" },
      { name: "Find PG", href: "/browse" },
      { name: "List Your PG", href: "/list-pg" },
    ],
    company: [
      { name: "About Us", href: "/about" },
      { name: "Careers", href: "/careers" },
      { name: "Blog", href: "/blog" },
      { name: "Contact", href: "/contact" },
    ],
    support: [
      { name: "Help Center", href: "/help" },
      { name: "User Guide", href: "/guide" },
      { name: "FAQs", href: "/faqs" },
      { name: "Privacy Policy", href: "/privacy" },
      { name: "Terms of Service", href: "/terms" },
    ],
  };

  const socialLinks = [
    { icon: Facebook, href: "#", label: "Facebook" },
    { icon: Twitter, href: "#", label: "Twitter" },
    { icon: Instagram, href: "#", label: "Instagram" },
    { icon: Linkedin, href: "#", label: "LinkedIn" },
  ];

  return (
    <footer className="bg-[#0f0b1f] text-slate-100 border-t border-white/10 pt-16 pb-[calc(2rem+env(safe-area-inset-bottom,0px))]">
      <div className="container mx-auto px-4">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-10 mb-12">
          <div className="lg:col-span-2">
            <Link to="/" className="inline-flex items-center gap-2.5 mb-5 min-h-[44px]">
              <div className="w-9 h-9 rounded-xl gradient-primary flex items-center justify-center">
                <Building2 className="w-5 h-5 text-white" />
              </div>
              <span className="text-lg font-bold text-white">PG Buddy</span>
            </Link>
            <p className="text-slate-300/80 mb-6 max-w-sm text-sm leading-relaxed">
              India's leading PG management platform. Simplifying property
              management for owners and making PG search easy for tenants.
            </p>
            <div className="space-y-2.5 text-sm text-slate-300/80">
              <a
                href={whatsappLink}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-3 min-h-[44px] sm:min-h-0 hover:text-white transition-colors"
              >
                <MessageCircle className="w-4 h-4 shrink-0" />
                <span>WhatsApp {BUSINESS.whatsappDisplay}</span>
              </a>
              <div className="flex items-center gap-3">
                <MapPin className="w-4 h-4 shrink-0" />
                <span>{BUSINESS.locality}</span>
              </div>
              <div className="flex items-start gap-3">
                <BadgeCheck className="w-4 h-4 shrink-0 mt-0.5" />
                <span>
                  {BUSINESS.legalName} · MSME (Udyam) registered
                  <br />
                  Udyam Registration No. {BUSINESS.udyamNumber}
                </span>
              </div>
            </div>
          </div>

          {Object.entries(footerLinks).map(([key, links]) => (
            <div key={key}>
              <h4 className="font-semibold mb-4 text-sm uppercase tracking-wider text-slate-200">
                {key.charAt(0).toUpperCase() + key.slice(1)}
              </h4>
              <ul className="space-y-1">
                {links.map((link) => (
                  <li key={link.name}>
                    <Link
                      to={link.href}
                      className="inline-flex items-center min-h-[44px] sm:min-h-0 py-1.5 text-sm text-slate-300/75 hover:text-white transition-colors"
                    >
                      {link.name}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="pt-8 border-t border-white/10 flex flex-col sm:flex-row items-center justify-between gap-4">
          <p className="text-xs text-slate-400">
            © {new Date().getFullYear()} {BUSINESS.legalName}. All rights reserved.
          </p>
          <div className="flex items-center gap-2">
            {socialLinks.map((social) => (
              <a
                key={social.label}
                href={social.href}
                aria-label={social.label}
                className="w-11 h-11 rounded-full bg-white/10 flex items-center justify-center hover:bg-white/20 transition-colors"
              >
                <social.icon className="w-4 h-4 text-slate-100" />
              </a>
            ))}
          </div>
        </div>
      </div>
    </footer>
  );
};

export default Footer;
