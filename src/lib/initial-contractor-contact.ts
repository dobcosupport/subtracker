import type { ContractorContactInput } from "@/types/database";

export const emptyInitialContact = {
  first_name: "",
  last_name: "",
  title_or_role: "",
  email: "",
  phone: "",
  is_primary_contact: false,
  receives_compliance_email: false,
};

export function initialContactInput(form: typeof emptyInitialContact): ContractorContactInput | null {
  const entered = [form.first_name, form.last_name, form.title_or_role, form.email, form.phone]
    .some((value) => value.trim()) || form.is_primary_contact || form.receives_compliance_email;
  if (!entered) return null;
  const contactName = [form.first_name.trim(), form.last_name.trim()].filter(Boolean).join(" ");
  if (!contactName) throw new Error("Enter a First Name or Last Name for the contact.");
  if (form.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) {
    throw new Error("Enter a valid contact email address.");
  }
  return {
    contact_name: contactName,
    title_or_role: form.title_or_role.trim() || null,
    email: form.email.trim() || null,
    business_phone: form.phone.trim() || null,
    mobile_phone: null,
    is_primary_contact: form.is_primary_contact,
    is_compliance_contact: false,
    receives_compliance_email: form.receives_compliance_email,
    is_active: true,
  };
}
